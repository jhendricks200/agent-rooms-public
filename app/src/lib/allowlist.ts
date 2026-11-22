// Participant allowlist for the deployed instance.
//
// The deployed app is publicly reachable and GitHub accounts are free, so
// without this any stranger who finds the URL could sign in, receive their
// own agent session, and spend the operator's inference budget. The
// per-session token cap bounds the blast radius of one account; it does
// nothing about the number of accounts.
//
// AGENT_ROOMS_ALLOWLIST is a comma-separated list of GitHub logins and/or
// numeric GitHub account ids. Numeric ids are the durable form and should
// be preferred for anyone whose handle might change; logins are accepted
// because they are what a person can tell you before they have ever signed
// in.
//
// Fail-open is deliberate when the variable is ABSENT: local development
// and the verify scripts must keep working without ceremony. Fail-closed
// is deliberate when the variable is PRESENT but empty, since that reads
// as "an allowlist was configured and nobody is on it."
const ALLOWLIST_ENV = 'AGENT_ROOMS_ALLOWLIST';

export interface AllowlistDecision {
  allowed: boolean;
  reason: 'no-allowlist-configured' | 'on-allowlist' | 'not-on-allowlist';
}

function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export function checkAllowlist(input: { login: string; githubUserId: string }): AllowlistDecision {
  const raw = process.env[ALLOWLIST_ENV];
  if (raw === undefined) {
    return { allowed: true, reason: 'no-allowlist-configured' };
  }
  const entries = parseAllowlist(raw);
  const login = input.login.trim().toLowerCase();
  const numeric = input.githubUserId.trim().toLowerCase();
  if ((login.length > 0 && entries.has(login)) || (numeric.length > 0 && entries.has(numeric))) {
    return { allowed: true, reason: 'on-allowlist' };
  }
  return { allowed: false, reason: 'not-on-allowlist' };
}
