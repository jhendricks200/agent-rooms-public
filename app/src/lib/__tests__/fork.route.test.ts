import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { forks } from '@/db/schema';
import { makeContributor, makeRoom, makeProposal, makeVersion, cleanup } from './testDb';

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('POST /api/fork', () => {
  let authorId: string;
  let roomId: string;
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  beforeEach(async () => {
    authorId = await makeContributor();
    contributorIds.push(authorId);
    roomId = await makeRoom({ maintainers: [authorId] });
    roomIds.push(roomId);
    currentContributorId = authorId;
  });

  afterEach(async () => {
    await cleanup({
      proposalIds: proposalIds.splice(0),
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
    });
  });

  async function importRoute() {
    const mod = await import('@/app/api/fork/route');
    return mod.POST;
  }

  it('401s an anonymous fork', async () => {
    currentContributorId = null;
    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId: 'p', proposalVersionId: 'v' }));
    expect(res.status).toBe(401);
  });

  it('returns a bundle carrying both the base ref and the exact base commit', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    expect(res.status).toBe(201);
    const json = await res.json();

    expect(json.bundle.baseRef).toBe('main');
    expect(json.bundle.baseSha).toBe('basesha0000000000000000000000000000000');
  });

  it('resolves the credit chain to names and titles beside the bundle', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    const json = await res.json();

    expect(json.chain).toHaveLength(1);
    expect(json.chain[0].id).toBe(proposalId);
    expect(typeof json.chain[0].authorName).toBe('string');
    expect(typeof json.chain[0].intentSummary).toBe('string');
  });

  // Forking the same version twice is one fact, not two. The forks list
  // rendered the duplicate rows as peers, which overstated interest in a
  // proposal and gave the forker no way back to what they already had.
  it('returns the existing fork instead of writing a second row', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId });

    const POST = await importRoute();
    const first = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    expect(first.status).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.alreadyForked).toBe(false);

    const second = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.alreadyForked).toBe(true);
    expect(secondJson.fork.id).toBe(firstJson.fork.id);

    const rows = await db.select().from(forks).where(eq(forks.proposalId, proposalId));
    expect(rows).toHaveLength(1);
  });

  // Two concurrent requests can both miss the fast-path select. The unique
  // index on (proposal, version, contributor) is the arbiter: the loser's
  // insert is a no-op and reads back the winner's row, so exactly one fork
  // exists and both callers get the same receipt.
  it('records exactly one row when the same fork is posted concurrently', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId });

    const POST = await importRoute();
    const [a, b] = await Promise.all([
      POST(fakeRequest({ proposalId, proposalVersionId: versionId })),
      POST(fakeRequest({ proposalId, proposalVersionId: versionId })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201].sort());
    const [aJson, bJson] = await Promise.all([a.json(), b.json()]);
    expect(aJson.fork.id).toBe(bJson.fork.id);

    const rows = await db.select().from(forks).where(eq(forks.proposalId, proposalId));
    expect(rows).toHaveLength(1);
  });

  // A different contributor forking the same version is a separate fact.
  it('still records a fork for a different contributor', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId });

    const POST = await importRoute();
    await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));

    const otherId = await makeContributor();
    contributorIds.push(otherId);
    currentContributorId = otherId;
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    expect(res.status).toBe(201);

    const rows = await db.select().from(forks).where(eq(forks.proposalId, proposalId));
    expect(rows).toHaveLength(2);
  });

  // A pending version is an in-flight promote: its branch and PR may not
  // exist, and its baseSha/headCommit/contentHash are still placeholders.
  it('refuses to fork a version that is not published', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: authorId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, status: 'pending' });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/not published/);

    const rows = await db.select().from(forks).where(eq(forks.proposalId, proposalId));
    expect(rows).toHaveLength(0);
  });
});
