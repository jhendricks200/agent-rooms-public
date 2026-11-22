import { describe, it, expect, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contributors } from '@/db/schema';
import { findOrCreateContributorByGithub } from '@/lib/contributor';
import { makeContributor, cleanup } from './testDb';

// Real-Postgres test: the whole point of this module is which database
// column identity is keyed on, and the unique indexes that back it, so an
// in-memory fake would test nothing that matters.
describe('findOrCreateContributorByGithub', () => {
  const contributorIds: string[] = [];
  const suffix = Math.random().toString(36).slice(2, 8);
  const track = (id: string) => {
    contributorIds.push(id);
    return id;
  };

  afterEach(async () => {
    await cleanup({ contributorIds: contributorIds.splice(0) });
  });

  it('creates a new contributor on first sign-in, keyed on the numeric account id', async () => {
    const { id } = await findOrCreateContributorByGithub({
      githubUserId: `9000${suffix}`,
      login: `octocat-${suffix}`,
      name: 'The Octocat',
    });
    track(id);

    const [row] = await db.select().from(contributors).where(eq(contributors.id, id)).limit(1);
    expect(row.displayName).toBe('The Octocat');
    expect(row.linkedGithubUserId).toBe(`9000${suffix}`);
    expect(row.linkedGithubId).toBe(`octocat-${suffix}`);
  });

  it('falls back to the login as displayName when the GitHub profile has no name', async () => {
    const { id } = await findOrCreateContributorByGithub({
      githubUserId: `9001${suffix}`,
      login: `anon-${suffix}`,
      name: null,
    });
    track(id);

    const [row] = await db.select().from(contributors).where(eq(contributors.id, id)).limit(1);
    expect(row.displayName).toBe(`anon-${suffix}`);
  });

  // The identity fix: a rename must not create a second contributor, and
  // must not lose the original's rooms, sessions, or maintainer authority.
  it('resolves the SAME contributor when the login changed but the numeric id did not', async () => {
    const first = await findOrCreateContributorByGithub({
      githubUserId: `9002${suffix}`,
      login: `oldname-${suffix}`,
      name: 'Renamed Person',
    });
    track(first.id);

    const second = await findOrCreateContributorByGithub({
      githubUserId: `9002${suffix}`,
      login: `newname-${suffix}`,
      name: 'Renamed Person',
    });

    expect(second.id).toBe(first.id);

    const [row] = await db.select().from(contributors).where(eq(contributors.id, first.id)).limit(1);
    expect(row.linkedGithubId).toBe(`newname-${suffix}`); // display metadata refreshed
    expect(row.linkedGithubUserId).toBe(`9002${suffix}`); // identity key unchanged
  });

  // The attack the fix closes: someone claims a released username and must
  // NOT inherit the original account's contributor row.
  it('creates a NEW contributor when a different numeric id reuses an old login', async () => {
    const original = await findOrCreateContributorByGithub({
      githubUserId: `9003${suffix}`,
      login: `reclaimed-${suffix}`,
      name: 'Original Owner',
    });
    track(original.id);

    // Original renames away, freeing the login.
    await findOrCreateContributorByGithub({
      githubUserId: `9003${suffix}`,
      login: `moved-on-${suffix}`,
      name: 'Original Owner',
    });

    // A different account claims the freed login.
    const impostor = await findOrCreateContributorByGithub({
      githubUserId: `9004${suffix}`,
      login: `reclaimed-${suffix}`,
      name: 'Someone Else',
    });
    track(impostor.id);

    expect(impostor.id).not.toBe(original.id);

    const rows = await db
      .select()
      .from(contributors)
      .where(inArray(contributors.id, [original.id, impostor.id]));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === original.id)!.linkedGithubUserId).toBe(`9003${suffix}`);
    expect(rows.find((r) => r.id === impostor.id)!.linkedGithubUserId).toBe(`9004${suffix}`);
  });

  // Seeded demo contributors carry a login but no numeric id. NULL never
  // matches, so a real GitHub account can never inherit a seeded persona.
  it('never matches a seeded contributor that has no numeric account id', async () => {
    const seeded = await makeContributor('Seeded Persona', { linkedGithubId: `seeded-${suffix}` });
    track(seeded);

    const resolved = await findOrCreateContributorByGithub({
      githubUserId: `9005${suffix}`,
      login: `seeded-${suffix}`,
      name: 'Impersonator',
    });
    track(resolved.id);

    expect(resolved.id).not.toBe(seeded);
  });

  it('refuses to resolve anything when the profile carries no numeric account id', async () => {
    await expect(
      findOrCreateContributorByGithub({ githubUserId: '', login: `nobody-${suffix}`, name: null }),
    ).rejects.toThrow(/numeric account id/);
  });
});
