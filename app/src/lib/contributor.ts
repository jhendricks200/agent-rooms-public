import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { contributors } from '@/db/schema';
import { generateId } from '@/lib/ids';

// Find-or-create a Contributor by GitHub identity.
//
// Identity is keyed on contributors.linkedGithubUserId, GitHub's immutable
// numeric account id, never on the login. A login is renameable, and a
// released login can be claimed by a different account: keying on it let a
// renamed-then-reclaimed username inherit the original contributor's
// private agent sessions and maintainer authority. The login is kept only
// as display metadata and refreshed at every sign-in.
//
// Seeded demo contributors have linkedGithubUserId NULL. A NULL never
// equals anything in SQL, so no real GitHub account can ever resolve to a
// seeded row through this function.
export async function findOrCreateContributorByGithub(profile: {
  githubUserId: string;
  login: string;
  name?: string | null;
}): Promise<{ id: string }> {
  const githubUserId = profile.githubUserId?.trim();
  if (!githubUserId) {
    // Fail closed: without the immutable id there is no safe key to match
    // on, and falling back to the login is exactly the bug this replaces.
    throw new Error('github profile has no numeric account id; refusing to resolve a contributor');
  }

  return db.transaction(async (tx) => {
    // Releasing the login from whichever contributor currently holds it
    // keeps the unique index satisfied when an account renames and another
    // account later claims the freed login. Display metadata follows the
    // account that currently presents the login; the identity key does not
    // move.
    async function claimLogin(contributorId: string) {
      await tx
        .update(contributors)
        .set({ linkedGithubId: null })
        .where(and(eq(contributors.linkedGithubId, profile.login), ne(contributors.id, contributorId)));
      await tx
        .update(contributors)
        .set({ linkedGithubId: profile.login })
        .where(eq(contributors.id, contributorId));
    }

    const [existing] = await tx
      .select({ id: contributors.id })
      .from(contributors)
      .where(eq(contributors.linkedGithubUserId, githubUserId))
      .limit(1);

    if (existing) {
      await claimLogin(existing.id);
      return existing;
    }

    const id = generateId('contributor');
    const [created] = await tx
      .insert(contributors)
      .values({
        id,
        displayName: profile.name?.trim() || profile.login,
        linkedGithubId: null,
        linkedGithubUserId: githubUserId,
      })
      .onConflictDoNothing()
      .returning({ id: contributors.id });

    if (created) {
      await claimLogin(created.id);
      return created;
    }

    // Race: another request created this contributor between select and
    // insert. Re-select rather than fail.
    const [row] = await tx
      .select({ id: contributors.id })
      .from(contributors)
      .where(eq(contributors.linkedGithubUserId, githubUserId))
      .limit(1);

    if (!row) {
      throw new Error(`failed to find-or-create contributor for github account id ${githubUserId}`);
    }
    await claimLogin(row.id);
    return row;
  });
}
