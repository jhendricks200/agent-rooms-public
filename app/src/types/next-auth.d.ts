// Session and JWT are actually declared in @auth/core (next-auth just
// re-exports the types), so augmenting 'next-auth' directly does not merge
// into the real interface. Augmenting the owning modules is what actually
// adds contributorId to the types seen through next-auth's re-exports.
import type { DefaultSession } from '@auth/core/types';

declare module '@auth/core/types' {
  interface Session extends DefaultSession {
    contributorId?: string;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    contributorId?: string;
    githubUserId?: string;
    githubLogin?: string;
  }
}
