import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeContributor, makeRoom, makeProposal, makeVersion, cleanup } from './testDb';

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

// Room contents, chat streams, and proposal diffs are not public. Each of
// these GETs used to return the full payload to an anonymous caller.
describe('authenticated reads', () => {
  let contributorId: string;
  let roomId: string;
  let proposalId: string;
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  beforeEach(async () => {
    contributorId = await makeContributor();
    contributorIds.push(contributorId);
    roomId = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomId);
    proposalId = await makeProposal({ roomId, authorContributorId: contributorId });
    proposalIds.push(proposalId);
    await makeVersion({ proposalId });
    currentContributorId = contributorId;
  });

  afterEach(async () => {
    await cleanup({
      proposalIds: proposalIds.splice(0),
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
    });
  });

  const roomParams = () => ({ params: Promise.resolve({ id: roomId }) });
  const proposalParams = () => ({ params: Promise.resolve({ id: proposalId }) });

  it('GET /api/rooms/[id] 401s anonymously and 200s for a signed-in contributor', async () => {
    const { GET } = await import('@/app/api/rooms/[id]/route');

    currentContributorId = null;
    expect((await GET(new Request('http://localhost/x'), roomParams())).status).toBe(401);

    currentContributorId = contributorId;
    const ok = await GET(new Request('http://localhost/x'), roomParams());
    expect(ok.status).toBe(200);
    expect((await ok.json()).room.id).toBe(roomId);
  });

  it('GET /api/rooms/[id]/messages 401s anonymously and 200s for a signed-in contributor', async () => {
    const { GET } = await import('@/app/api/rooms/[id]/messages/route');
    const request = new Request('http://localhost/x') as unknown as import('next/server').NextRequest;

    currentContributorId = null;
    expect((await GET(request, roomParams())).status).toBe(401);

    currentContributorId = contributorId;
    expect((await GET(request, roomParams())).status).toBe(200);
  });

  it('GET /api/proposals/[id] 401s anonymously and 200s for a signed-in contributor', async () => {
    const { GET } = await import('@/app/api/proposals/[id]/route');

    currentContributorId = null;
    expect((await GET(new Request('http://localhost/x'), proposalParams())).status).toBe(401);

    currentContributorId = contributorId;
    const ok = await GET(new Request('http://localhost/x'), proposalParams());
    expect(ok.status).toBe(200);
    expect((await ok.json()).proposal.id).toBe(proposalId);
  });

  it('GET /api/proposals/[id] never returns a pending version', async () => {
    const pendingProposalId = await makeProposal({ roomId, authorContributorId: contributorId });
    proposalIds.push(pendingProposalId);
    await makeVersion({ proposalId: pendingProposalId, status: 'pending' });

    const { GET } = await import('@/app/api/proposals/[id]/route');
    currentContributorId = contributorId;
    const res = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: pendingProposalId }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).versions).toHaveLength(0);
  });
});
