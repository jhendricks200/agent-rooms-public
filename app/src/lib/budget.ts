// Room budget enforcement and atomic usage reservations for the sidebar
// agent (app/src/app/api/agent/message/route.ts). See docs/design/
// promote-provenance.md, Safety mechanics item 4: "Pooled-key usage is
// rate-capped per user and per room, with a kill switch."
//
// Reservation model: reserveUsage runs inside one DB transaction that locks
// the room row (SELECT ... FOR UPDATE), checks the kill switch and every
// cap against a conservative estimate, and if admitted, inserts a
// agent_usage_reservations row and bumps rooms.tokenBudgetUsed, all before
// the model is ever called. The row lock serializes concurrent requests for
// the same room, so two requests racing past a cap check is not possible:
// the second transaction blocks until the first commits or rolls back, and
// re-reads the (now updated) counters. reconcileUsage/releaseReservation
// settle the reservation afterward.
//
// Cap windowing: all three caps (the global per-session
// AGENT_DAILY_TOKEN_CAP, the per-room tokenBudgetPerRoom, and the per-user
// tokenBudgetPerUser) are windowed to the current UTC day and reset
// together at midnight UTC (startOfDayUtc below is the single boundary).
// None of them is a lifetime total. Every windowed figure is summed from
// agent_usage_reservations rows created at or after the boundary, counting
// only 'pending' and 'committed' rows, so a released reservation (a failed,
// aborted, or swept-stale request) counts against nothing.
//
// rooms.tokenBudgetUsed is a monotonic lifetime counter and therefore
// cannot express a window; it is deliberately NOT an input to the
// admission decision. It is still maintained (incremented on reserve,
// adjusted on settle) as a cheap cumulative usage figure for display and
// debugging only.
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, agentUsageReservations } from '@/db/schema';
import { generateId } from '@/lib/ids';

export const DEFAULT_DAILY_TOKEN_CAP = 200_000;

// The hard output ceiling. This is both the output half of every
// reservation AND the max_tokens sent on the model request (see
// lib/model.ts), so a completion cannot physically exceed what was
// reserved for it. Changing one without the other reintroduces the gap.
export const MAX_OUTPUT_TOKENS = 4_000;

// Per-message framing overhead: role tokens, message delimiters, and the
// chat template's own scaffolding, none of which appear in the content
// string. Deliberately generous; the estimate must never undercount.
const PER_MESSAGE_OVERHEAD_TOKENS = 8;

// Characters per token for the input upper bound. Real tokenizers average
// roughly 4 characters per token for English prose and worse for dense,
// unspaced content (minified code, base64, CJK). 3 is a conservative
// floor that overcounts ordinary text rather than undercounting anything.
const CHARS_PER_TOKEN_LOWER_BOUND = 3;

// A pending reservation whose request died before it could settle would
// otherwise count against every cap forever. Anything pending longer than
// this is treated as abandoned and released on the next admission check.
export const PENDING_RESERVATION_TIMEOUT_MS = 10 * 60_000;

let loggedInvalidDailyCap = false;

// Validates AGENT_DAILY_TOKEN_CAP once per process. A non-numeric or
// negative value is a misconfiguration, not "no cap": it fails closed to
// the documented default rather than silently disabling the check (which
// is what `Number('bad') -> NaN` did before, since every `>= NaN`
// comparison is false).
export function getDailyTokenCap(): number {
  const raw = process.env.AGENT_DAILY_TOKEN_CAP;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_TOKEN_CAP;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!loggedInvalidDailyCap) {
      loggedInvalidDailyCap = true;
      console.error(
        `[budget] AGENT_DAILY_TOKEN_CAP="${raw}" is not a valid non-negative number; failing closed to the default cap of ${DEFAULT_DAILY_TOKEN_CAP}.`,
      );
    }
    return DEFAULT_DAILY_TOKEN_CAP;
  }
  return parsed;
}

export interface RoomCaps {
  tokenBudgetPerRoom: number | null;
  tokenBudgetPerUser: number | null;
}

const warnedRoomCapKeys = new Set<string>();

// Validates the room's configured budgets at first use. null means "no cap"
// and passes through. A negative value can only reach the database by
// bypassing the API's zod validation (positive-int only), so this is
// defense in depth: it fails closed to 0 (blocks all usage in that room
// until corrected) rather than falling back to "no cap", and logs once per
// room per field so a misconfigured room does not spam logs on every
// message.
export function getValidatedRoomCaps(room: {
  id: string;
  tokenBudgetPerRoom: number | null;
  tokenBudgetPerUser: number | null;
}): RoomCaps {
  function validate(value: number | null, label: string): number | null {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value) || value < 0) {
      const key = `${room.id}:${label}`;
      if (!warnedRoomCapKeys.has(key)) {
        warnedRoomCapKeys.add(key);
        console.error(
          `[budget] room ${room.id} has an invalid ${label}=${value}; failing closed to 0 (blocks all usage) until corrected.`,
        );
      }
      return 0;
    }
    return value;
  }

  return {
    tokenBudgetPerRoom: validate(room.tokenBudgetPerRoom, 'tokenBudgetPerRoom'),
    tokenBudgetPerUser: validate(room.tokenBudgetPerUser, 'tokenBudgetPerUser'),
  };
}

// The single window boundary shared by the daily, room, and user caps: the
// most recent midnight UTC. Every cap counts only usage recorded at or
// after this instant, so all three reset together at 00:00 UTC.
export function startOfDayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Conservative upper bound on a request's total tokens: a character-based
// input estimate plus per-message framing overhead, plus the hard output
// ceiling that is also enforced as max_tokens on the request itself.
//
// The previous whitespace word-count estimator undercounted badly on dense
// content: a 3,000-character minified blob with no spaces counted as one
// word, roughly two tokens, while the real prompt costs a thousand or
// more. Counting characters cannot be gamed that way.
export function estimateRequestTokens(messages: { content: string }[]): number {
  const estimatedInput = messages.reduce(
    (n, m) => n + Math.ceil(m.content.length / CHARS_PER_TOKEN_LOWER_BOUND) + PER_MESSAGE_OVERHEAD_TOKENS,
    0,
  );
  return estimatedInput + MAX_OUTPUT_TOKENS;
}

export type ReserveResult =
  | { kind: 'ok'; reservationId: string; estimatedTokens: number }
  | { kind: 'room_missing' }
  | { kind: 'kill_switch' }
  | { kind: 'daily_cap'; used: number; cap: number }
  | { kind: 'room_cap'; used: number; cap: number }
  | { kind: 'user_cap'; used: number; cap: number };

const ACTIVE_STATUSES = ['pending', 'committed'] as const;

export async function reserveUsage(opts: {
  roomId: string;
  sessionId: string;
  contributorId: string;
  estimatedTokens: number;
}): Promise<ReserveResult> {
  const dailyCap = getDailyTokenCap();
  // One boundary value for the whole admission decision, so the daily,
  // user, and room checks cannot disagree about where the window starts if
  // the transaction happens to straddle midnight UTC.
  const windowStart = startOfDayUtc();

  return db.transaction(async (tx) => {
    const [lockedRoomBeforeSweep] = await tx
      .select()
      .from(rooms)
      .where(eq(rooms.id, opts.roomId))
      .for('update');
    if (!lockedRoomBeforeSweep) return { kind: 'room_missing' as const };
    if (lockedRoomBeforeSweep.killSwitchEnabled) return { kind: 'kill_switch' as const };

    // Stale-reservation recovery, on the admission path so a room can never
    // be permanently blocked by ghost estimates from crashed requests.
    const swept = await sweepStalePendingReservations(tx, opts.roomId);
    const lockedRoom = swept
      ? (await tx.select().from(rooms).where(eq(rooms.id, opts.roomId)))[0]
      : lockedRoomBeforeSweep;

    const caps = getValidatedRoomCaps(lockedRoom);

    // coalesce(actual_tokens, estimated_tokens): a committed reservation's
    // real usage is almost always far below its conservative estimate (the
    // estimate exists purely for admission control), so counting the
    // estimate forever would exhaust the daily/user cap on far less real
    // usage than the cap advertises. A still-pending reservation (a
    // request genuinely in flight right now) has no actual figure yet, so
    // its estimate is the correct, conservative stand-in until it resolves.
    const [sessionUsageRow] = await tx
      .select({
        total: sql<number>`coalesce(sum(coalesce(${agentUsageReservations.actualTokens}, ${agentUsageReservations.estimatedTokens})), 0)`,
      })
      .from(agentUsageReservations)
      .where(
        and(
          eq(agentUsageReservations.sessionId, opts.sessionId),
          inArray(agentUsageReservations.status, ACTIVE_STATUSES),
          gte(agentUsageReservations.createdAt, windowStart),
        ),
      );
    const sessionUsed = Number(sessionUsageRow?.total ?? 0);
    if (sessionUsed + opts.estimatedTokens > dailyCap) {
      return { kind: 'daily_cap' as const, used: sessionUsed, cap: dailyCap };
    }

    // Per-user cap, windowed to the current UTC day exactly like the daily
    // cap above (same boundary, same status filter). Before windowing this
    // query had no date filter at all, so one contributor's usage
    // accumulated forever and the room became permanently unusable for them.
    if (caps.tokenBudgetPerUser != null) {
      const [userUsageRow] = await tx
        .select({
          total: sql<number>`coalesce(sum(coalesce(${agentUsageReservations.actualTokens}, ${agentUsageReservations.estimatedTokens})), 0)`,
        })
        .from(agentUsageReservations)
        .where(
          and(
            eq(agentUsageReservations.roomId, opts.roomId),
            eq(agentUsageReservations.contributorId, opts.contributorId),
            inArray(agentUsageReservations.status, ACTIVE_STATUSES),
            gte(agentUsageReservations.createdAt, windowStart),
          ),
        );
      const userUsed = Number(userUsageRow?.total ?? 0);
      if (userUsed + opts.estimatedTokens > caps.tokenBudgetPerUser) {
        return { kind: 'user_cap' as const, used: userUsed, cap: caps.tokenBudgetPerUser };
      }
    }

    // Per-room cap, windowed on the same boundary. Derived from this room's
    // reservation rows rather than rooms.tokenBudgetUsed: that column is a
    // monotonic lifetime counter with no timestamps in it, so it cannot be
    // windowed and must not decide admission. The reservation ledger can,
    // and it already excludes released rows.
    if (caps.tokenBudgetPerRoom != null) {
      const [roomUsageRow] = await tx
        .select({
          total: sql<number>`coalesce(sum(coalesce(${agentUsageReservations.actualTokens}, ${agentUsageReservations.estimatedTokens})), 0)`,
        })
        .from(agentUsageReservations)
        .where(
          and(
            eq(agentUsageReservations.roomId, opts.roomId),
            inArray(agentUsageReservations.status, ACTIVE_STATUSES),
            gte(agentUsageReservations.createdAt, windowStart),
          ),
        );
      const roomUsed = Number(roomUsageRow?.total ?? 0);
      if (roomUsed + opts.estimatedTokens > caps.tokenBudgetPerRoom) {
        return { kind: 'room_cap' as const, used: roomUsed, cap: caps.tokenBudgetPerRoom };
      }
    }

    const reservationId = generateId('agent_reservation');
    await tx.insert(agentUsageReservations).values({
      id: reservationId,
      sessionId: opts.sessionId,
      roomId: opts.roomId,
      contributorId: opts.contributorId,
      estimatedTokens: opts.estimatedTokens,
      status: 'pending',
    });
    // Lifetime cumulative counter, kept current for display and debugging.
    // Not read by any cap check (see the windowing note in the file header).
    await tx
      .update(rooms)
      .set({ tokenBudgetUsed: sql`${rooms.tokenBudgetUsed} + ${opts.estimatedTokens}` })
      .where(eq(rooms.id, opts.roomId));

    return { kind: 'ok' as const, reservationId, estimatedTokens: opts.estimatedTokens };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Releases every pending reservation in a room that has outlived
// PENDING_RESERVATION_TIMEOUT_MS, backing its estimate out of the lifetime
// room counter. Marking the rows 'released' is what actually frees the
// windowed caps, since those sum only pending and committed rows. Returns
// true when anything was released, so the caller knows to re-read the room
// row it already locked. Must be called with the room row already locked
// FOR UPDATE.
async function sweepStalePendingReservations(tx: Tx, roomId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TIMEOUT_MS);
  const stale = await tx
    .select({ id: agentUsageReservations.id, estimatedTokens: agentUsageReservations.estimatedTokens })
    .from(agentUsageReservations)
    .where(
      and(
        eq(agentUsageReservations.roomId, roomId),
        eq(agentUsageReservations.status, 'pending'),
        lt(agentUsageReservations.createdAt, cutoff),
      ),
    )
    .for('update');

  if (stale.length === 0) return false;

  const total = stale.reduce((n, r) => n + r.estimatedTokens, 0);
  await tx
    .update(agentUsageReservations)
    .set({ status: 'released', resolvedAt: new Date() })
    .where(
      inArray(
        agentUsageReservations.id,
        stale.map((r) => r.id),
      ),
    );
  await tx
    .update(rooms)
    .set({ tokenBudgetUsed: sql`greatest(${rooms.tokenBudgetUsed} - ${total}, 0)` })
    .where(eq(rooms.id, roomId));

  console.warn(
    `[budget] released ${stale.length} stale pending reservation(s) totalling ${total} tokens in room ${roomId}.`,
  );
  return true;
}

export type SettleResult = 'settled' | 'noop';

// Settles a reservation exactly once. The reservation row itself is locked
// FOR UPDATE and must still be 'pending': a retried reconcile, a double
// release, or a release arriving after a commit finds a non-pending row and
// is a no-op, so the room counter can never be adjusted twice for one
// request and a late release can never erase recorded usage.
//
// The room counter is adjusted by a delta against the row's own stored
// estimate, never overwritten, since other requests may have reserved or
// committed concurrently.
async function settleReservation(
  reservationId: string,
  settle: (estimatedTokens: number) => { status: 'committed' | 'released'; actualTokens: number | null; delta: number },
): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const [reservation] = await tx
      .select()
      .from(agentUsageReservations)
      .where(eq(agentUsageReservations.id, reservationId))
      .for('update');

    if (!reservation || reservation.status !== 'pending') return 'noop';

    const outcome = settle(reservation.estimatedTokens);

    await tx
      .update(rooms)
      .set({ tokenBudgetUsed: sql`greatest(${rooms.tokenBudgetUsed} + ${outcome.delta}, 0)` })
      .where(eq(rooms.id, reservation.roomId));

    await tx
      .update(agentUsageReservations)
      .set({ status: outcome.status, actualTokens: outcome.actualTokens, resolvedAt: new Date() })
      .where(and(eq(agentUsageReservations.id, reservationId), eq(agentUsageReservations.status, 'pending')));

    return 'settled';
  });
}

// Reconciles a reservation to actual usage once the model call completed.
export async function reconcileUsage(opts: {
  reservationId: string;
  actualTokens: number;
}): Promise<SettleResult> {
  return settleReservation(opts.reservationId, (estimatedTokens) => ({
    status: 'committed',
    actualTokens: opts.actualTokens,
    delta: opts.actualTokens - estimatedTokens,
  }));
}

// Releases a reservation that never turned into real usage (model call
// failed, refused off-policy, or the client aborted the stream). The
// estimated amount is backed out of the room counter.
export async function releaseReservation(opts: { reservationId: string }): Promise<SettleResult> {
  return settleReservation(opts.reservationId, (estimatedTokens) => ({
    status: 'released',
    actualTokens: null,
    delta: -estimatedTokens,
  }));
}
