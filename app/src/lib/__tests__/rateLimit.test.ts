import { describe, it, expect, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rateLimitEvents } from '@/db/schema';
import { generateId } from '@/lib/ids';
import {
  RATE_LIMITS,
  checkRateLimit,
  isMissingTableError,
  rateLimitResponse,
  type RateLimitedAction,
} from '@/lib/rateLimit';

// Runs against the real local Postgres, like the route tests, because the
// property that matters here is what the advisory lock does under
// concurrent transactions. The limiter needs no contributor row (the table
// has no foreign key by design), so ids are random strings.
describe('checkRateLimit', () => {
  const ids: string[] = [];

  function contributor() {
    const id = generateId('contributor_ratelimit_test');
    ids.push(id);
    return id;
  }

  async function rowCount(contributorId: string, action: RateLimitedAction) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rateLimitEvents)
      .where(and(eq(rateLimitEvents.contributorId, contributorId), eq(rateLimitEvents.action, action)));
    return row.n;
  }

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      await db.delete(rateLimitEvents).where(eq(rateLimitEvents.contributorId, id));
    }
  });

  it('allows exactly max requests in a window and refuses the next one', async () => {
    const who = contributor();
    const rule = { max: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(who, 'message.post', rule)).allowed).toBe(true);
    }
    const refused = await checkRateLimit(who, 'message.post', rule);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.action).toBe('message.post');
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('a refused request writes nothing, so repeated refusals do not grow the table or extend the limit', async () => {
    const who = contributor();
    const rule = { max: 2, windowSeconds: 60 };
    await checkRateLimit(who, 'fork.create', rule);
    await checkRateLimit(who, 'fork.create', rule);
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(who, 'fork.create', rule)).allowed).toBe(false);
    }
    expect(await rowCount(who, 'fork.create')).toBe(2);
  });

  it('counts each action separately for the same contributor', async () => {
    const who = contributor();
    const rule = { max: 1, windowSeconds: 60 };
    expect((await checkRateLimit(who, 'room.create', rule)).allowed).toBe(true);
    expect((await checkRateLimit(who, 'room.create', rule)).allowed).toBe(false);
    expect((await checkRateLimit(who, 'message.post', rule)).allowed).toBe(true);
  });

  it('counts each contributor separately for the same action', async () => {
    const a = contributor();
    const b = contributor();
    const rule = { max: 1, windowSeconds: 60 };
    expect((await checkRateLimit(a, 'proposal.promote', rule)).allowed).toBe(true);
    expect((await checkRateLimit(a, 'proposal.promote', rule)).allowed).toBe(false);
    expect((await checkRateLimit(b, 'proposal.promote', rule)).allowed).toBe(true);
  });

  it('lets requests through again once the window has passed, and prunes the expired rows', async () => {
    const who = contributor();
    const rule = { max: 2, windowSeconds: 60 };
    await checkRateLimit(who, 'message.post', rule);
    await checkRateLimit(who, 'message.post', rule);
    expect((await checkRateLimit(who, 'message.post', rule)).allowed).toBe(false);

    // Age both rows past the window instead of sleeping for a minute.
    await db
      .update(rateLimitEvents)
      .set({ createdAt: sql`now() - interval '61 seconds'` })
      .where(eq(rateLimitEvents.contributorId, who));

    expect((await checkRateLimit(who, 'message.post', rule)).allowed).toBe(true);
    // The two expired rows are gone; only the new one remains.
    expect(await rowCount(who, 'message.post')).toBe(1);
  });

  it('reports how long until the oldest request ages out', async () => {
    const who = contributor();
    const rule = { max: 1, windowSeconds: 60 };
    await checkRateLimit(who, 'message.post', rule);
    await db
      .update(rateLimitEvents)
      .set({ createdAt: sql`now() - interval '40 seconds'` })
      .where(eq(rateLimitEvents.contributorId, who));
    const refused = await checkRateLimit(who, 'message.post', rule);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(19);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(21);
    }
  });

  // The reason for the advisory lock. Without it, simultaneous requests
  // each count before any of them has written, and all of them pass.
  it('admits exactly max of a burst of simultaneous requests', async () => {
    const who = contributor();
    const rule = { max: 5, windowSeconds: 60 };
    const results = await Promise.all(
      Array.from({ length: 25 }, () => checkRateLimit(who, 'proposal.promote', rule)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await rowCount(who, 'proposal.promote')).toBe(5);
  });

  it('uses the configured ceiling for the action when no rule is passed', async () => {
    const who = contributor();
    const { max } = RATE_LIMITS['room.create'];
    for (let i = 0; i < max; i++) {
      expect((await checkRateLimit(who, 'room.create')).allowed).toBe(true);
    }
    expect((await checkRateLimit(who, 'room.create')).allowed).toBe(false);
  });

  it('rateLimitResponse returns null when allowed and a 429 with Retry-After when refused', async () => {
    const who = contributor();
    const { max } = RATE_LIMITS['room.create'];
    for (let i = 0; i < max; i++) {
      expect(await rateLimitResponse(who, 'room.create')).toBeNull();
    }
    const res = await rateLimitResponse(who, 'room.create');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    const retryAfter = Number(res!.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMITS['room.create'].windowSeconds);
    const body = await res!.json();
    expect(body).toMatchObject({ error: 'rate limit exceeded', action: 'room.create' });
  });
});

describe('isMissingTableError', () => {
  it('recognises the Postgres code on the error or on a wrapped cause', () => {
    expect(isMissingTableError({ code: '42P01' })).toBe(true);
    expect(isMissingTableError(new Error('wrapped', { cause: { code: '42P01' } }))).toBe(true);
  });

  it('does not match other database errors or non-errors', () => {
    expect(isMissingTableError({ code: '23505' })).toBe(false);
    expect(isMissingTableError(new Error('boom'))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError('42P01')).toBe(false);
  });
});
