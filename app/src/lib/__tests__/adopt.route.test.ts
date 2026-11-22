import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@/db/client';
import { proposals, adoptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeContributor, makeRoom, makeProposal, makeVersion, cleanup } from './testDb';

const mergeMock = vi.fn();
const pullsGetMock = vi.fn();

vi.mock('octokit', () => {
  class FakeApp {
    async getInstallationOctokit() {
      return { rest: { pulls: { merge: mergeMock, get: pullsGetMock } } };
    }
  }
  return { App: FakeApp };
});

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
const originalEnv: Record<string, string | undefined> = {};

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('POST /api/adopt', () => {
  let maintainerId: string;
  let roomId: string;
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  beforeEach(async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';
    mergeMock.mockReset();
    pullsGetMock.mockReset();

    maintainerId = await makeContributor();
    contributorIds.push(maintainerId);
    roomId = await makeRoom({ maintainers: [maintainerId] });
    roomIds.push(roomId);
    currentContributorId = maintainerId;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) process.env[key] = originalEnv[key];
    await cleanup({ proposalIds: proposalIds.splice(0), roomIds: roomIds.splice(0), contributorIds: contributorIds.splice(0) });
  });

  async function importRoute() {
    const mod = await import('@/app/api/adopt/route');
    return mod.POST;
  }

  it('returns 503 and records nothing when GITHUB_APP credentials are absent (fail-closed, no stub-success)', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;

    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7 });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(503);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('open');
  });

  it('returns 409 and records nothing when the version has no associated PR', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: null });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('open');
  });

  it('honors the exact requested proposalVersionId: 404 when it does not exist', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    await makeVersion({ proposalId, prNumber: 7 });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: 'version_does_not_exist', roomId }));
    expect(res.status).toBe(404);
  });

  it('409s when the requested proposalVersionId is not the latest published version', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const older = await makeVersion({ proposalId, prNumber: 7, publishedAt: new Date(Date.now() - 60_000) });
    await makeVersion({ proposalId, prNumber: 8, publishedAt: new Date() });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: older, roomId }));
    expect(res.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('merges and records an Adoption when the version is the only one and matches (pinning allows the sole version)', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });
    mergeMock.mockResolvedValueOnce({ data: { merged: true, sha: 'merge-sha', message: 'merged' } });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(201);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('adopted');
  });

  it('maps an invalid state transition (already adopted) to 409, not an uncaught error', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId, state: 'adopted' });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7 });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('409s and records nothing when the pinned version is not published', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, status: 'pending' });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('releases the attempt and records no Adoption when GitHub rejects the merge', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });
    mergeMock.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(409);

    const rows = await db.select().from(adoptions).where(eq(adoptions.proposalId, proposalId));
    expect(rows).toHaveLength(0);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('open');
  });

  // Crash safety. The merge succeeded on GitHub but the process died
  // before the Adoption could be finalized, leaving a pending attempt. A
  // retry must finalize from GitHub's own answer, never merge twice.
  it('finalizes a stale attempt from GitHub state without issuing a second merge', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });

    // Simulate the crash: the merge happened, the finalize did not.
    mergeMock.mockResolvedValueOnce({ data: { merged: true, sha: 'merge-sha', message: 'merged' } });
    const { ADOPTION_ATTEMPT_RECOVERY_MS } = await import('@/app/api/adopt/route');
    await db.insert(adoptions).values({
      id: `adoption_stale_${proposalId}`,
      proposalId,
      proposalVersionId: versionId,
      roomId,
      adoptedByContributorId: maintainerId,
      expectedHeadCommit: 'sha-1',
      mergeResult: 'attempt recorded; merge not yet issued',
      mergeCommitSha: null,
      adoptionReceiptRef: `adoption_stale_${proposalId}`,
      status: 'pending',
      adoptedAt: new Date(Date.now() - ADOPTION_ATTEMPT_RECOVERY_MS - 5_000),
    });

    pullsGetMock.mockResolvedValueOnce({
      data: {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        head: { sha: 'sha-1' },
        state: 'closed',
        merged: true,
        merge_commit_sha: 'merge-sha',
      },
    });

    const POST = await importRoute();
    const res = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(res.status).toBe(201);

    // The decisive assertion: no second merge was issued.
    expect(mergeMock).not.toHaveBeenCalled();
    expect(pullsGetMock).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(adoptions).where(eq(adoptions.proposalId, proposalId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('merged');
    expect(rows[0].mergeCommitSha).toBe('merge-sha');

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('adopted');
  });

  it('releases a stale attempt whose merge never happened, so the proposal can be adopted later', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });

    const { ADOPTION_ATTEMPT_RECOVERY_MS } = await import('@/app/api/adopt/route');
    await db.insert(adoptions).values({
      id: `adoption_stale2_${proposalId}`,
      proposalId,
      proposalVersionId: versionId,
      roomId,
      adoptedByContributorId: maintainerId,
      expectedHeadCommit: 'sha-1',
      mergeResult: 'attempt recorded; merge not yet issued',
      mergeCommitSha: null,
      adoptionReceiptRef: `adoption_stale2_${proposalId}`,
      status: 'pending',
      adoptedAt: new Date(Date.now() - ADOPTION_ATTEMPT_RECOVERY_MS - 5_000),
    });

    pullsGetMock.mockResolvedValueOnce({
      data: {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        head: { sha: 'sha-1' },
        state: 'open',
        merged: false,
        merge_commit_sha: null,
      },
    });

    const POST = await importRoute();
    const first = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(first.status).toBe(409);
    expect(mergeMock).not.toHaveBeenCalled();

    let rows = await db.select().from(adoptions).where(eq(adoptions.proposalId, proposalId));
    expect(rows).toHaveLength(0);

    // The released attempt leaves the proposal adoptable.
    mergeMock.mockResolvedValueOnce({ data: { merged: true, sha: 'merge-sha', message: 'merged' } });
    const second = await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }));
    expect(second.status).toBe(201);
    expect(mergeMock).toHaveBeenCalledTimes(1);

    rows = await db.select().from(adoptions).where(eq(adoptions.proposalId, proposalId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('merged');
  });

  it('refuses a second adopt once the proposal is already adopted', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });
    mergeMock.mockResolvedValueOnce({ data: { merged: true, sha: 'merge-sha', message: 'merged' } });

    const POST = await importRoute();
    expect((await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }))).status).toBe(201);
    expect((await POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }))).status).toBe(409);
    expect(mergeMock).toHaveBeenCalledTimes(1);
  });

  it('concurrency: two parallel adopt requests for the same proposal only let one succeed', async () => {
    const proposalId = await makeProposal({ roomId, authorContributorId: maintainerId });
    proposalIds.push(proposalId);
    const versionId = await makeVersion({ proposalId, prNumber: 7, headCommit: 'sha-1' });

    // Both calls resolve successfully from GitHub's point of view; the race
    // must be decided by our own row lock + state re-check, not by GitHub.
    mergeMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: { merged: true, sha: 'merge-sha', message: 'merged' } }), 30),
        ),
    );

    const POST = await importRoute();
    const body = fakeRequest({ proposalId, proposalVersionId: versionId, roomId });
    const [resA, resB] = await Promise.all([POST(body), POST(fakeRequest({ proposalId, proposalVersionId: versionId, roomId }))]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    expect(proposal.state).toBe('adopted');
  });
});
