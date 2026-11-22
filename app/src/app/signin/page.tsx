import { redirect } from 'next/navigation';
import { getCurrentContributorId } from '@/lib/session';
import { SignInDoor } from '@/components/SignInDoor';
import { ThemeToggle } from '@/components/ThemeToggle';
import { BrandMark } from '@/components/BrandMark';

export const dynamic = 'force-dynamic';

// Only a same-origin relative path is ever honored as a redirect target.
// callbackUrl arrives as an untrusted query string (room/[id]/page.tsx and
// proposal/[id]/page.tsx set it, but so could anyone crafting a link) - and
// Auth.js's own `init()` rewrites what those pages send into an *absolute*
// URL (http://host/room/x) before it ever reaches this page, because the
// GET /api/auth/signin route it passes through resolves callbackUrl
// against its own base URL. Parsing with a throwaway base and keeping only
// pathname+search+hash discards whatever host the input carried either
// way, so a same-origin relative path and an attacker's
// `//evil.com/x` both come out as a safe relative path - the value handed
// to next-auth/react's signIn() and Auth.js's own redirect callback (the
// real gate at sign-in time) is the same one shown on the button.
function safeCallbackUrl(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return '/';
  try {
    const parsed = new URL(value, 'http://placeholder.invalid');
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith('/') ? path : '/';
  } catch {
    return '/';
  }
}

function firstParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; login?: string; ghid?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(params.callbackUrl);

  // Already signed in (including the dev-fallback identity): nothing left
  // for this page to do, same as Auth.js's own default sign-in page.
  const currentContributorId = await getCurrentContributorId();
  if (currentContributorId) {
    redirect(callbackUrl);
  }

  // auth.ts's signIn callback redirects here with ?error=AccessDenied and
  // the two identifiers the allowlist accepts, rather than returning
  // `false` into Auth.js's own generic error page. No session or
  // contributor row exists for a denied sign-in - the login/id below come
  // straight from that redirect, not from a cookie.
  const login = firstParam(params.login);
  const denied =
    params.error === 'AccessDenied' && login.length > 0
      ? { login, githubUserId: firstParam(params.ghid) }
      : null;

  return (
    <div className="signin-shell">
      <div className="signin-door">
        <div className="signin-top">
          <div className="brand">
            <BrandMark className="mark" />
            <span className="word">Agent Rooms</span>
          </div>
          <span className="spacer" />
          <ThemeToggle />
        </div>

        <main className="signin-body">
          <SignInDoor callbackUrl={callbackUrl} denied={denied} />
        </main>
      </div>

      <aside className="signin-aside" aria-label="What signing in unlocks">
        <p className="signin-aside-head">In the room</p>
        <div className="signin-status-list">
          <div className="signin-status-row">
            <span className="emblem e-room" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="2" />
                <path d="M2.4 6.5h11.2" />
              </svg>
            </span>
            <span className="label">
              Chat, private per builder
              <span className="sub">Everyone talks in one stream; your agent works beside you, unseen by the rest of the room.</span>
            </span>
          </div>
          <div className="signin-status-row">
            <span className="emblem e-fork" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M5 3.8v4.6a3 3 0 0 0 3 3h3" />
                <circle cx="5" cy="2.6" r="1.5" />
                <circle cx="11.8" cy="12.4" r="1.5" />
              </svg>
            </span>
            <span className="label">
              Promote opens a real pull request
              <span className="sub">Agent output becomes a proposal on the room&rsquo;s linked GitHub repo, not a screenshot in chat.</span>
            </span>
          </div>
          <div className="signin-status-row">
            <span className="emblem e-lineage" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1.9l1.85 3.9 4.05.55-2.95 2.95.75 4.1L8 11.35 4.3 13.4l.75-4.1L2.1 6.35l4.05-.55z" />
              </svg>
            </span>
            <span className="label">
              Adopt is a SHA-pinned merge
              <span className="sub">Winners get merged for real, and the credit chain to every proposal it was built on is recorded.</span>
            </span>
          </div>
        </div>
        <p className="signin-aside-note">
          Nothing about who&rsquo;s already in a given room is shown here before you sign in - the
          room itself isn&rsquo;t public, only the mechanic is.
        </p>
      </aside>
    </div>
  );
}
