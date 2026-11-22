// Per-contributor rate limits for the routes that write.
//
// Why this exists: lib/budget.ts bounds what the sidebar agent can spend,
// and lib/allowlist.ts bounds who can sign in, but nothing bounded how fast
// a signed-in contributor could create rooms, post, promote, fork, adopt or
// reject. Promote is the expensive one: each call can open a pull request
// through the room's GitHub App.
//
// How it counts: each request to a limited route takes a transaction-scoped
// advisory lock keyed on (contributor, action), counts that contributor's
// rows for the action inside the window, and writes one more row only if
// there is room. The lock is what makes the count exact: without it, two
// simultaneous requests would each count before the other had written and
// both pass. Only requests from the same contributor for the same action
// wait on each other, and only for three short statements. A refused
// request writes nothing, so hammering a closed limit neither extends it
// nor grows the table.
//
// What it is not: a per-IP or anonymous limit. Every limited route already
// 401s without a contributor, and the key here is the contributor id, so
// this says nothing about unauthenticated traffic. That is the platform
// firewall's job.
import { NextResponse } from 'next/server';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rateLimitEvents } from '@/db/schema';
import { generateId } from '@/lib/ids';

export type RateLimitedAction =
  | 'room.create'
  | 'message.post'
  | 'proposal.promote'
  | 'fork.create'
  | 'proposal.decide';

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

// Ceilings are set well above what a person working in a room does, and
// above what scripts/stage0.ts does per persona, so a limit firing means
// something is looping. proposal.decide covers adopt and reject together:
// both are maintainer-only and each proposal can leave 'open' once, so the
// only way to reach the ceiling is to retry the same decisions repeatedly.
export const RATE_LIMITS: Record<RateLimitedAction, RateLimitRule> = {
  'room.create': { max: 10, windowSeconds: 60 * 60 },
  'message.post': { max: 30, windowSeconds: 60 },
  'proposal.promote': { max: 20, windowSeconds: 10 * 60 },
  'fork.create': { max: 60, windowSeconds: 10 * 60 },
  'proposal.decide': { max: 60, windowSeconds: 10 * 60 },
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; action: RateLimitedAction; retryAfterSeconds: number };

// Postgres error code for "relation does not exist".
const UNDEFINED_TABLE = '42P01';

// drizzle wraps driver errors, so the code can sit on the error itself or
// on its cause.
export function isMissingTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === UNDEFINED_TABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function checkRateLimit(
  contributorId: string,
  action: RateLimitedAction,
  rule: RateLimitRule = RATE_LIMITS[action],
): Promise<RateLimitDecision> {
  const windowStart = sql`now() - make_interval(secs => ${rule.windowSeconds})`;
  const mine = and(eq(rateLimitEvents.contributorId, contributorId), eq(rateLimitEvents.action, action));
  const lockKey = `ratelimit:${action}:${contributorId}`;

  try {
    return await db.transaction(async (tx) => {
      // Released automatically when the transaction ends, on commit or on
      // error. A hash collision between two keys only makes two unrelated
      // checks wait for each other.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      await tx.delete(rateLimitEvents).where(and(mine, lt(rateLimitEvents.createdAt, windowStart)));

      const [row] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          // Seconds until the oldest row in the window ages out, which is
          // when one slot opens again. Null when there are no rows.
          retryAfterSeconds: sql<
            number | null
          >`ceil(extract(epoch from (min(${rateLimitEvents.createdAt}) + make_interval(secs => ${rule.windowSeconds}) - now())))::int`,
        })
        .from(rateLimitEvents)
        .where(mine);

      if (row.count >= rule.max) {
        return {
          allowed: false as const,
          action,
          retryAfterSeconds: Math.min(rule.windowSeconds, Math.max(1, row.retryAfterSeconds ?? 1)),
        };
      }

      await tx.insert(rateLimitEvents).values({ id: generateId('ratelimit'), contributorId, action });
      return { allowed: true as const };
    });
  } catch (error) {
    // The one failure that is allowed through. Migrations here are applied
    // by hand, so a deploy can briefly run ahead of its migration. Without
    // this, forgetting migration 0010 would 500 every write route in the
    // app; with it, the app behaves exactly as it did before the limiter
    // existed, and says so loudly. Every other database error still throws.
    if (isMissingTableError(error)) {
      console.error(
        '[SECURITY] rate limiting is OFF: table rate_limit_events does not exist. Apply the pending migration (npm run db:migrate).',
      );
      return { allowed: true };
    }
    throw error;
  }
}

// Route helper: returns the 429 to send, or null when the request may
// proceed. Call it immediately after the 401 check, before the body is
// parsed, so malformed requests count toward the ceiling too.
export async function rateLimitResponse(
  contributorId: string,
  action: RateLimitedAction,
): Promise<NextResponse | null> {
  const decision = await checkRateLimit(contributorId, action);
  if (decision.allowed) return null;
  return NextResponse.json(
    { error: 'rate limit exceeded', action: decision.action, retryAfterSeconds: decision.retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
  );
}
