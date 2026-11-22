'use client';

import { signIn, signOut } from 'next-auth/react';
import { avatarClass, initials } from '@/lib/ui';

export interface AuthProfileProps {
  currentUser: { id: string; displayName: string } | null;
}

// Left-rail profile row: "Sign in with GitHub" when logged out, avatar +
// display name + "Sign out" when logged in. Uses existing rail-profile
// styles, no new design tokens.
export function AuthProfile({ currentUser }: AuthProfileProps) {
  if (!currentUser) {
    return (
      <button className="rail-item" type="button" onClick={() => signIn('github')}>
        Sign in with GitHub
      </button>
    );
  }

  return (
    <>
      <span className={`avatar ${avatarClass(currentUser.id)}`}>{initials(currentUser.displayName)}</span>
      <span className="who">
        <span className="nm">{currentUser.displayName}</span>
        <button className="plan" type="button" onClick={() => signOut()}>
          Sign out
        </button>
      </span>
    </>
  );
}
