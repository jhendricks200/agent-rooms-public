import { headers } from 'next/headers';
import { auth } from '@/auth';

// Dev-only fallback identity: the seed script's own persona. Only resolves
// when NODE_ENV=development AND DEV_IDENTITY_FALLBACK=1 is explicitly set
// AND the process is not running on a hosted deployment (see
// onHostedDeployment below), so local demo/verify scripts keep working
// without real sign-in. This value must never resolve in production, and
// must never resolve in dev without the flag: unauthenticated requests must
// otherwise return null so callers can 401.
// Exported so dev-only verify scripts can look up rows by this id when
// DEV_IDENTITY_FALLBACK=1 is set for their own run; never used for
// authorization decisions outside this file.
export const DEV_FALLBACK_CONTRIBUTOR_ID = 'contributor_priya';

// Second, independent gate on the dev fallback. NODE_ENV alone used to be
// the only thing standing between a misconfigured deployment and an
// unauthenticated request resolving to a seeded identity. Vercel sets its
// own system variables on every deployment, separately from NODE_ENV, so
// reading them means two unrelated settings both have to be wrong before
// the fallback can resolve on a hosted instance. `vercel dev` on a
// developer's machine reports VERCEL_ENV=development and is still allowed.
export function onHostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === 'production' || vercelEnv === 'preview') return true;
  return env.VERCEL === '1' && vercelEnv !== 'development';
}

export function devFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (onHostedDeployment(env)) return false;
  return env.NODE_ENV === 'development' && env.DEV_IDENTITY_FALLBACK === '1';
}

// Stage 0 identity override (scripts/stage0.ts). Real Auth.js sign-in is
// GitHub OAuth, impractical to script for five fictional personas hitting
// the HTTP API directly. Rather than write straight to the database (which
// the harness must not do for the loop itself), the harness sends a header
// naming which persona is acting, and this reads it back as the
// contributor id. Gated behind FOUR conditions so it can never affect a
// real deployment or a real dev session that forgot to set it:
//   - not a hosted deployment (same gate as DEV_IDENTITY_FALLBACK)
//   - NODE_ENV=development (same gate as DEV_IDENTITY_FALLBACK)
//   - DEV_IDENTITY_FALLBACK=1 (same gate as DEV_IDENTITY_FALLBACK)
//   - STAGE0_IDENTITY_OVERRIDE=1, a separate flag nothing else sets
// This is weaker than real auth: the header is a client-supplied claim,
// not a verified identity. It is only ever safe because all three gates
// above are off by default and off in production. See the
// validation protocol's Stage 0 section and the stage0 report's fidelity
// caveat.
export const STAGE0_IDENTITY_HEADER = 'x-stage0-contributor-id';

function stage0OverrideEnabled(): boolean {
  return devFallbackEnabled() && process.env.STAGE0_IDENTITY_OVERRIDE === '1';
}

async function stage0OverrideContributorId(): Promise<string | null> {
  if (!stage0OverrideEnabled()) return null;
  const h = await headers();
  const id = h.get(STAGE0_IDENTITY_HEADER);
  return id && id.trim().length > 0 ? id.trim() : null;
}

// Resolves the acting contributor id from the real server-side session
// (Auth.js `auth()`), never from anything client-supplied. Returns null
// when there is no session and no dev fallback is active; callers must
// treat null as unauthenticated and respond 401 for any mutation.
export async function getCurrentContributorId(): Promise<string | null> {
  const session = await auth();
  if (session?.contributorId) {
    return session.contributorId;
  }
  const stage0Id = await stage0OverrideContributorId();
  if (stage0Id) {
    return stage0Id;
  }
  if (devFallbackEnabled()) {
    return DEV_FALLBACK_CONTRIBUTOR_ID;
  }
  return null;
}
