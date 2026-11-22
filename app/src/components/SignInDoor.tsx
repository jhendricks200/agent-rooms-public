'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

const GH_ICON = (
  <svg className="gh-glyph" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export interface SignInDoorProps {
  callbackUrl: string;
  /** Set when Auth.js sent us back with ?error=AccessDenied. */
  denied: {
    login: string;
    githubUserId: string;
  } | null;
}

// The one real action on this page: hands off to Auth.js's GitHub OAuth
// flow, preserving the callbackUrl the caller was actually headed to
// (room/[id]/page.tsx and proposal/[id]/page.tsx both redirect here with
// one). A client component because signIn() from next-auth/react only
// works client-side, and because the button needs a pending state - the
// mock's honestly-shown "opening github.com" rather than a dead click.
function GithubButton({ callbackUrl, compact, label }: { callbackUrl: string; compact?: boolean; label: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={`btn-primary gh-btn${compact ? ' compact' : ''}`}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void signIn('github', { callbackUrl });
      }}
    >
      {pending ? (
        <>
          opening github.com
          <span className="pending-dot" aria-hidden="true" />
        </>
      ) : (
        <>
          {GH_ICON}
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export function SignInDoor({ callbackUrl, denied }: SignInDoorProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    const markCopied = () => {
      setCopied(key);
      setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1600);
    };
    // design/screen-signin.html's own copy handler runs the same "Copied"
    // feedback on both the success and failure branch of writeText - a
    // denied clipboard permission (sandboxed iframes, some browser
    // policies) shouldn't leave the button looking like it did nothing.
    // execCommand is deprecated but still the only synchronous fallback
    // when the async Clipboard API is unavailable outright.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(markCopied, markCopied);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // Nothing left to try; markCopied still runs below so the control
      // never looks inert.
    }
    document.body.removeChild(ta);
    markCopied();
  };

  if (denied) {
    return (
      <section className="signin-card" aria-labelledby="deniedH1">
        <p className="signin-eyebrow">Access &middot; not on the invite list</p>
        <h1 id="deniedH1">You&rsquo;re not on the invite list yet</h1>

        <div className="signin-who">
          <span className="avatar a-default" aria-hidden="true">
            {denied.login.slice(0, 2).toUpperCase()}
          </span>
          <span className="who-txt">
            <span className="nm">{denied.login}</span>
            <span className="hd">github.com/{denied.login}</span>
          </span>
          <span className="verified">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.8 8.4l3 3 7.4-8" />
            </svg>
            GitHub verified
          </span>
        </div>

        <p className="signin-sub" style={{ maxWidth: 'none' }}>
          This is a closed test, so every account that opens a room is invited by name. GitHub
          confirmed who you are; Agent Rooms just doesn&rsquo;t have you on the list. Nothing was
          recorded against your account.
        </p>

        <div className="signin-handoff">
          <h2>Send this to whoever invited you</h2>
          <div className="signin-copy-row">
            <span className="cr-key">Handle</span>
            <span className="cr-val">{denied.login}</span>
            <button
              type="button"
              className={`signin-copy-btn${copied === 'login' ? ' done' : ''}`}
              onClick={() => copy(denied.login, 'login')}
            >
              {copied === 'login' ? 'Copied' : 'Copy'}
            </button>
          </div>
          {denied.githubUserId && (
            <div className="signin-copy-row">
              <span className="cr-key">Account id</span>
              <span className="cr-val">{denied.githubUserId}</span>
              <button
                type="button"
                className={`signin-copy-btn${copied === 'id' ? ' done' : ''}`}
                onClick={() => copy(denied.githubUserId, 'id')}
              >
                {copied === 'id' ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          <p className="hint">Either line works. The numeric id is the durable one, since handles can change and ids cannot.</p>
        </div>

        <div className="signin-deny-actions">
          <GithubButton callbackUrl={callbackUrl} compact label="Try a different account" />
          <a href="/signin" className="btn-quiet">
            Back to sign in
          </a>
        </div>

        <div className="signin-rule" />
        <p className="signin-foot">Invite only while the current test runs</p>
      </section>
    );
  }

  return (
    <section className="signin-card" aria-labelledby="signinH1">
      <p className="signin-eyebrow">Closed test &middot; invited accounts only</p>
      <h1 id="signinH1">Sign in to Agent Rooms</h1>
      <p className="signin-sub">Your agent works in private. The room ships the result.</p>

      <GithubButton callbackUrl={callbackUrl} label="Continue with GitHub" />

      <p className="signin-fineprint">
        Reads your public profile and account id. Pull requests are opened by the app on the
        room&rsquo;s repo, never from your account.
      </p>

      <div className="signin-rule" />
      <p className="signin-foot">Invite only while the current test runs</p>
    </section>
  );
}
