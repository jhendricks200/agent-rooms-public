import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { findOrCreateContributorByGithub } from '@/lib/contributor';
import { checkAllowlist } from '@/lib/allowlist';

// GitHub sign-in via the registered GitHub App's OAuth. clientSecret is
// intentionally allowed to be empty: this only means the OAuth token
// exchange will fail at sign-in time with Auth.js's own error page, not
// that the app fails to boot. Sign-in activates automatically once
// GITHUB_OAUTH_CLIENT_SECRET is set in .env.
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  pages: {
    // src/app/signin/page.tsx (design/screen-signin.html). Every existing
    // `redirect('/api/auth/signin?callbackUrl=...')` in the app keeps
    // working unchanged: Auth.js's own signin route reads this option and
    // forwards to it with callbackUrl preserved (@auth/core/lib/pages).
    signIn: '/signin',
  },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? 'Iv23liGWHQRprQK8V1kZ',
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
    }),
  ],
  callbacks: {
    // Refuses an unknown account before any contributor row is created, so
    // a stranger who finds the deployed URL never gets a session or an
    // agent budget. See lib/allowlist.ts for the fail-open and fail-closed
    // reasoning.
    //
    // Returning a URL (rather than `false`) from this callback still
    // refuses the sign-in - Auth.js redirects there without ever reaching
    // the jwt/session callbacks below, so a denied account gets no token
    // and no contributor row either way (@auth/core handleAuthorized). The
    // difference is only that the denied page can show the two identifiers
    // the allowlist accepts (design/denied-aside-options.html), which a
    // bare `false` gives it no way to know. login and the numeric id are
    // GitHub's own public profile fields, not secrets.
    async signIn({ profile }) {
      if (!profile || typeof profile.login !== 'string') return false;
      const githubUserId =
        typeof profile.id === 'number' || typeof profile.id === 'string' ? String(profile.id) : '';
      const decision = checkAllowlist({ login: profile.login, githubUserId });
      if (!decision.allowed) {
        console.warn(`[auth] refused sign-in for ${profile.login} (${githubUserId}): not on allowlist`);
        const denyParams = new URLSearchParams({ error: 'AccessDenied', login: profile.login });
        if (githubUserId) denyParams.set('ghid', githubUserId);
        return `/signin?${denyParams.toString()}`;
      }
      return true;
    },
    async jwt({ token, profile }) {
      // profile is only present on the sign-in request itself; on
      // subsequent requests the token carries whatever was set here before.
      //
      // profile.id is GitHub's immutable numeric account id and is the
      // identity key. profile.login is a renameable display handle and is
      // never used to match an existing contributor.
      if (profile && typeof profile.login === 'string') {
        const githubUserId =
          typeof profile.id === 'number' || typeof profile.id === 'string' ? String(profile.id) : '';
        const contributor = await findOrCreateContributorByGithub({
          githubUserId,
          login: profile.login,
          name: typeof profile.name === 'string' ? profile.name : null,
        });
        token.contributorId = contributor.id;
        // Carried so the allowlist can be re-checked on every session
        // resolution, not just at sign-in (see the session callback).
        token.githubUserId = githubUserId;
        token.githubLogin = profile.login;
      }
      return token;
    },
    async session({ session, token }) {
      // A sign-in-time check alone lets a removed tester keep a valid JWT
      // for its full lifetime. Re-check the allowlist on every session
      // resolution; it is an in-memory env parse, so this costs nothing. A
      // failing check leaves contributorId unset, so getCurrentContributorId
      // returns null and every route treats the caller as unauthenticated.
      // token.sub is the GitHub provider's user id, kept as a fallback for
      // tokens issued before githubUserId was stashed explicitly.
      const decision = checkAllowlist({
        login: typeof token.githubLogin === 'string' ? token.githubLogin : '',
        githubUserId:
          typeof token.githubUserId === 'string'
            ? token.githubUserId
            : typeof token.sub === 'string'
              ? token.sub
              : '',
      });
      if (decision.allowed && typeof token.contributorId === 'string') {
        session.contributorId = token.contributorId;
      }
      return session;
    },
  },
});
