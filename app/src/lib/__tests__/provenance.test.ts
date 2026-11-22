import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposalVersions } from '@/db/schema';
import { buildLineageChain, brokenLineageLinks } from '@/lib/lineage';
import { makeContributor, makeRoom, makeProposal, makeVersion, cleanup } from './testDb';

describe('published ProposalVersion immutability (database trigger)', () => {
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  afterEach(async () => {
    await cleanup({
      proposalIds: proposalIds.splice(0),
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
    });
  });

  // drizzle wraps the driver error, so the trigger's own message lives on
  // the cause chain rather than the top-level message.
  async function expectRejection(promise: Promise<unknown>, pattern: RegExp) {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const messages: string[] = [];
    let current: unknown = caught;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(' | ')).toMatch(pattern);
  }

  async function setup(status: 'pending' | 'published' = 'published') {
    const contributorId = await makeContributor();
    contributorIds.push(contributorId);
    const roomId = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomId);
    const proposalId = await makeProposal({ roomId, authorContributorId: contributorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, status });
    return versionId;
  }

  it('rejects an UPDATE of a frozen column on a published version', async () => {
    const versionId = await setup();
    await expectRejection(
      db
        .update(proposalVersions)
        .set({ diffRef: 'rewritten history' })
        .where(eq(proposalVersions.versionId, versionId)),
      /immutable/,
    );

    const [row] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.versionId, versionId))
      .limit(1);
    expect(row.diffRef).not.toBe('rewritten history');
  });

  it('rejects rewriting the contentHash of a published version', async () => {
    const versionId = await setup();
    await expectRejection(
      db
        .update(proposalVersions)
        .set({ contentHash: 'b'.repeat(64) })
        .where(eq(proposalVersions.versionId, versionId)),
      /immutable/,
    );
  });

  it('rejects a DELETE of a published version', async () => {
    const versionId = await setup();
    await expectRejection(
      db.delete(proposalVersions).where(eq(proposalVersions.versionId, versionId)),
      /cannot be deleted/,
    );
  });

  it('permits the one legitimate transition: pending to published', async () => {
    const versionId = await setup('pending');
    await db
      .update(proposalVersions)
      .set({ status: 'published', headCommit: 'real-head-sha', prNumber: 42 })
      .where(eq(proposalVersions.versionId, versionId));

    const [row] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.versionId, versionId))
      .limit(1);
    expect(row.status).toBe('published');
    expect(row.headCommit).toBe('real-head-sha');
  });

  it('permits deleting a pending version, so a failed promote can roll back', async () => {
    const versionId = await setup('pending');
    await db.delete(proposalVersions).where(eq(proposalVersions.versionId, versionId));

    const rows = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.versionId, versionId));
    expect(rows).toHaveLength(0);
  });

  it('refuses to demote a published version back to pending', async () => {
    const versionId = await setup();
    await expectRejection(
      db
        .update(proposalVersions)
        .set({ status: 'pending' })
        .where(eq(proposalVersions.versionId, versionId)),
      /immutable/,
    );
  });
});

describe('lineage broken links', () => {
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  afterEach(async () => {
    await cleanup({
      proposalIds: proposalIds.splice(0),
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
    });
  });

  // A chain that silently drops an unresolvable ancestor reads as complete
  // provenance when it is not.
  it('reports a missing ancestor as an explicit broken-link node instead of dropping it', async () => {
    const contributorId = await makeContributor();
    contributorIds.push(contributorId);
    const roomId = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomId);

    const ghostId = 'proposal_vanished_ancestor';
    const child = await makeProposal({
      roomId,
      authorContributorId: contributorId,
      parentProposalIds: [ghostId],
    });
    proposalIds.push(child);

    const chain = await buildLineageChain(child);
    const broken = brokenLineageLinks(chain);

    expect(chain.map((n) => n.id)).toContain(ghostId);
    expect(broken.map((n) => n.id)).toEqual([ghostId]);
    expect(chain.find((n) => n.id === child)!.missing).toBeUndefined();
  });

  it('reports nothing broken for a fully intact chain', async () => {
    const contributorId = await makeContributor();
    contributorIds.push(contributorId);
    const roomId = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomId);

    const parent = await makeProposal({ roomId, authorContributorId: contributorId });
    proposalIds.push(parent);
    const child = await makeProposal({
      roomId,
      authorContributorId: contributorId,
      parentProposalIds: [parent],
    });
    proposalIds.push(child);

    const chain = await buildLineageChain(child);
    expect(brokenLineageLinks(chain)).toEqual([]);
    expect(chain.map((n) => n.id).sort()).toEqual([child, parent].sort());
  });
});

// Guards the guard: the escape hatch the test fixtures and seed script use
// exists, is session-scoped, and is not on by default.
describe('provenance escape hatch', () => {
  it('is off unless explicitly set for the transaction', async () => {
    const result = await db.execute(
      sql`SELECT coalesce(current_setting('agent_rooms.allow_provenance_mutation', true), 'unset') AS value`,
    );
    expect((result.rows[0] as { value: string }).value).not.toBe('on');
  });
});
