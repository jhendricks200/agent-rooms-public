import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, agentUsageReservations } from '@/db/schema';
import {
  getDailyTokenCap,
  getValidatedRoomCaps,
  estimateRequestTokens,
  reserveUsage,
  reconcileUsage,
  releaseReservation,
  startOfDayUtc,
  DEFAULT_DAILY_TOKEN_CAP,
  MAX_OUTPUT_TOKENS,
  PENDING_RESERVATION_TIMEOUT_MS,
} from '@/lib/budget';
import { makeContributor, makeRoom, makeAgentSession, makeReservation, cleanup } from './testDb';

describe('getDailyTokenCap', () => {
  const original = process.env.AGENT_DAILY_TOKEN_CAP;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_DAILY_TOKEN_CAP;
    else process.env.AGENT_DAILY_TOKEN_CAP = original;
  });

  it('returns the default when unset', () => {
    delete process.env.AGENT_DAILY_TOKEN_CAP;
    expect(getDailyTokenCap()).toBe(DEFAULT_DAILY_TOKEN_CAP);
  });

  it('parses a valid numeric override', () => {
    process.env.AGENT_DAILY_TOKEN_CAP = '5000';
    expect(getDailyTokenCap()).toBe(5000);
  });

  it('fails closed to the default and logs once when the value is non-numeric', () => {
    process.env.AGENT_DAILY_TOKEN_CAP = 'not-a-number';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getDailyTokenCap()).toBe(DEFAULT_DAILY_TOKEN_CAP);
    getDailyTokenCap();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('fails closed to the default when the value is negative', () => {
    process.env.AGENT_DAILY_TOKEN_CAP = '-100';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getDailyTokenCap()).toBe(DEFAULT_DAILY_TOKEN_CAP);
    errSpy.mockRestore();
  });
});

describe('getValidatedRoomCaps', () => {
  it('passes null through as no cap', () => {
    const caps = getValidatedRoomCaps({ id: 'room_x', tokenBudgetPerRoom: null, tokenBudgetPerUser: null });
    expect(caps).toEqual({ tokenBudgetPerRoom: null, tokenBudgetPerUser: null });
  });

  it('fails closed to 0 for a negative value and logs once per room per field', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const caps = getValidatedRoomCaps({ id: 'room_negative_test', tokenBudgetPerRoom: -5, tokenBudgetPerUser: 100 });
    expect(caps).toEqual({ tokenBudgetPerRoom: 0, tokenBudgetPerUser: 100 });
    getValidatedRoomCaps({ id: 'room_negative_test', tokenBudgetPerRoom: -5, tokenBudgetPerUser: 100 });
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe('estimateRequestTokens', () => {
  it('is conservative: grows with message length and includes the hard output allowance', () => {
    const small = estimateRequestTokens([{ content: 'hi' }]);
    const large = estimateRequestTokens([{ content: 'word '.repeat(1000) }]);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(MAX_OUTPUT_TOKENS - 1);
  });

  // The old whitespace word-count estimator counted this whole blob as a
  // single "word", roughly two input tokens, so a request whose real prompt
  // costs a thousand tokens or more was admitted against a two-token
  // reservation. A character-based bound cannot be gamed that way.
  it('does not undercount dense non-whitespace content', () => {
    const dense = 'x'.repeat(9_000); // one whitespace "word"
    const oldStyleEstimate = Math.ceil(1 / 0.75); // what the word counter produced
    const estimate = estimateRequestTokens([{ content: dense }]) - MAX_OUTPUT_TOKENS;

    expect(oldStyleEstimate).toBeLessThan(10);
    expect(estimate).toBeGreaterThanOrEqual(3_000);
  });
});

describe('reserveUsage / reconcileUsage / releaseReservation', () => {
  let contributorId: string;
  let roomId: string;
  let sessionId: string;
  const roomIds: string[] = [];
  const contributorIds: string[] = [];
  const sessionIds: string[] = [];

  afterEach(async () => {
    await cleanup({ roomIds: roomIds.splice(0), contributorIds: contributorIds.splice(0), sessionIds: sessionIds.splice(0) });
  });

  async function setup(roomOpts: Parameters<typeof makeRoom>[0] = { maintainers: [] }) {
    contributorId = await makeContributor();
    contributorIds.push(contributorId);
    roomId = await makeRoom({ ...roomOpts, maintainers: [contributorId] });
    roomIds.push(roomId);
    sessionId = await makeAgentSession({ ownerContributorId: contributorId, roomId });
    sessionIds.push(sessionId);
  }

  it('admits a request under every cap and bumps tokenBudgetUsed atomically', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 10_000, tokenBudgetPerUser: 5_000 });
    const result = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    expect(result.kind).toBe('ok');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(1_000);
  });

  it('refuses with kill_switch when the room kill switch is enabled', async () => {
    await setup({ maintainers: [], killSwitchEnabled: true });
    const result = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 100 });
    expect(result.kind).toBe('kill_switch');
  });

  it('refuses with room_cap once tokenBudgetPerRoom would be exceeded', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });
    const first = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 900 });
    expect(first.kind).toBe('ok');
    const second = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 900 });
    expect(second.kind).toBe('room_cap');
  });

  it('refuses with user_cap once tokenBudgetPerUser would be exceeded, independent of room budget', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000_000, tokenBudgetPerUser: 500 });
    const first = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 400 });
    expect(first.kind).toBe('ok');
    const second = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 400 });
    expect(second.kind).toBe('user_cap');
  });

  it('reconcileUsage adjusts tokenBudgetUsed by the delta between estimate and actual', async () => {
    await setup();
    const reserved = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    if (reserved.kind !== 'ok') throw new Error('expected ok');
    await reconcileUsage({ reservationId: reserved.reservationId, actualTokens: 300 });

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(300);
  });

  it('releaseReservation backs the estimate back out entirely', async () => {
    await setup();
    const reserved = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    if (reserved.kind !== 'ok') throw new Error('expected ok');
    await releaseReservation({ reservationId: reserved.reservationId });

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(0);
  });

  // Exactly-once settlement. Each of these repeats used to double-adjust
  // the room counter, because nothing locked the reservation row or
  // required it to still be pending.
  it('a second reconcile is a no-op and does not double-adjust the room counter', async () => {
    await setup();
    const reserved = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    if (reserved.kind !== 'ok') throw new Error('expected ok');

    expect(await reconcileUsage({ reservationId: reserved.reservationId, actualTokens: 300 })).toBe('settled');
    expect(await reconcileUsage({ reservationId: reserved.reservationId, actualTokens: 300 })).toBe('noop');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(300);
  });

  it('a second release is a no-op and cannot drive the counter below the real total', async () => {
    await setup();
    const keeper = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 500 });
    const reserved = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    if (keeper.kind !== 'ok' || reserved.kind !== 'ok') throw new Error('expected ok');

    expect(await releaseReservation({ reservationId: reserved.reservationId })).toBe('settled');
    expect(await releaseReservation({ reservationId: reserved.reservationId })).toBe('noop');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(500);
  });

  it('a release arriving after a commit is a no-op and never erases recorded usage', async () => {
    await setup();
    const reserved = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 1_000 });
    if (reserved.kind !== 'ok') throw new Error('expected ok');

    await reconcileUsage({ reservationId: reserved.reservationId, actualTokens: 800 });
    expect(await releaseReservation({ reservationId: reserved.reservationId })).toBe('noop');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(800);

    const [row] = await db
      .select()
      .from(agentUsageReservations)
      .where(eq(agentUsageReservations.id, reserved.reservationId))
      .limit(1);
    expect(row.status).toBe('committed');
    expect(row.actualTokens).toBe(800);
  });

  // Stale-reservation recovery: a crash between reserve and settle used to
  // leave a pending row counting against every cap forever.
  it('releases timed-out pending reservations on the admission path and frees the cap', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });

    const ghostId = await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 900,
      status: 'pending',
      createdAt: new Date(Date.now() - PENDING_RESERVATION_TIMEOUT_MS - 60_000),
    });
    await db
      .update(rooms)
      .set({ tokenBudgetUsed: 900 })
      .where(eq(rooms.id, roomId));

    const admitted = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(admitted.kind).toBe('ok');

    const [ghost] = await db
      .select()
      .from(agentUsageReservations)
      .where(eq(agentUsageReservations.id, ghostId))
      .limit(1);
    expect(ghost.status).toBe('released');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(800);
  });

  it('leaves a fresh pending reservation alone: only timed-out ones are swept', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });

    const inFlightId = await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 900,
      status: 'pending',
    });
    await db.update(rooms).set({ tokenBudgetUsed: 900 }).where(eq(rooms.id, roomId));

    const refused = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(refused.kind).toBe('room_cap');

    const [row] = await db
      .select()
      .from(agentUsageReservations)
      .where(eq(agentUsageReservations.id, inFlightId))
      .limit(1);
    expect(row.status).toBe('pending');
  });

  // Cap windowing. The room cap and the user cap are windowed on the same
  // midnight-UTC boundary the daily cap already used, and both are summed
  // from the reservation ledger rather than from the monotonic
  // rooms.tokenBudgetUsed counter. `beforeWindow` is one hour before the
  // boundary, so it belongs to the previous UTC day; `insideWindow` is now.
  //
  // Fixtures use status 'committed' deliberately: a 'pending' row older than
  // PENDING_RESERVATION_TIMEOUT_MS would be released by the stale sweep, and
  // that would free the cap for a reason other than the window under test.
  const beforeWindow = () => new Date(startOfDayUtc().getTime() - 60 * 60_000);

  it('room cap: usage recorded before the window boundary does not count', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });

    await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 900,
      status: 'committed',
      createdAt: beforeWindow(),
    });

    const admitted = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(admitted.kind).toBe('ok');
  });

  it('room cap: usage recorded inside the window does count and refuses with room_cap', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });

    await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 900,
      status: 'committed',
      createdAt: new Date(),
    });

    const refused = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(refused.kind).toBe('room_cap');
    if (refused.kind !== 'room_cap') throw new Error('expected room_cap');
    expect(refused.used).toBe(900);
    expect(refused.cap).toBe(1_000);
  });

  // The monotonic counter cannot be windowed, so it must no longer be an
  // input to admission: a room whose lifetime counter is far past its cap is
  // still admitted when nothing was used inside the current window.
  it('room cap: ignores the lifetime rooms.tokenBudgetUsed counter entirely', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });
    await db.update(rooms).set({ tokenBudgetUsed: 5_000_000 }).where(eq(rooms.id, roomId));

    const admitted = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(admitted.kind).toBe('ok');
  });

  it('user cap: usage recorded before the window boundary does not count', async () => {
    await setup({ maintainers: [], tokenBudgetPerUser: 500 });

    await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 400,
      status: 'committed',
      createdAt: beforeWindow(),
    });

    const admitted = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 400 });
    expect(admitted.kind).toBe('ok');
  });

  it('user cap: usage recorded inside the window does count and refuses with user_cap', async () => {
    await setup({ maintainers: [], tokenBudgetPerUser: 500 });

    await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 400,
      status: 'committed',
      createdAt: new Date(),
    });

    const refused = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 400 });
    expect(refused.kind).toBe('user_cap');
    if (refused.kind !== 'user_cap') throw new Error('expected user_cap');
    expect(refused.used).toBe(400);
    expect(refused.cap).toBe(500);
  });

  it('a released reservation inside the window counts toward neither the room cap nor the user cap', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000, tokenBudgetPerUser: 1_000 });

    await makeReservation({
      sessionId,
      roomId,
      contributorId,
      estimatedTokens: 900,
      status: 'released',
      createdAt: new Date(),
    });

    const admitted = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(admitted.kind).toBe('ok');
  });

  // A second contributor's usage in the same room counts against the room
  // cap (it is per room, not per user) but not against this user's cap.
  it('room cap is shared across contributors while the user cap is not', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000, tokenBudgetPerUser: 1_000 });

    const otherContributorId = await makeContributor();
    contributorIds.push(otherContributorId);
    const otherSessionId = await makeAgentSession({ ownerContributorId: otherContributorId, roomId });
    sessionIds.push(otherSessionId);

    await makeReservation({
      sessionId: otherSessionId,
      roomId,
      contributorId: otherContributorId,
      estimatedTokens: 900,
      status: 'committed',
      createdAt: new Date(),
    });

    const refused = await reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 800 });
    expect(refused.kind).toBe('room_cap');
  });

  // The core TOCTOU fix: two genuinely concurrent reservation attempts for
  // the same room, sized so both together exceed the room's budget but
  // either one alone fits. Only one may be admitted.
  it('concurrency: two parallel reservations that together exceed the cap admit exactly one', async () => {
    await setup({ maintainers: [], tokenBudgetPerRoom: 1_000 });

    const [a, b] = await Promise.all([
      reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 700 }),
      reserveUsage({ roomId, sessionId, contributorId, estimatedTokens: 700 }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['ok', 'room_cap']);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(700);
  });
});
