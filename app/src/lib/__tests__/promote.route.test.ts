import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposals, proposalVersions } from '@/db/schema';
import { makeContributor, makeRoom, cleanup } from './testDb';

const getRefMock = vi.fn();
const getCommitMock = vi.fn();
const getTreeMock = vi.fn();
const createRefMock = vi.fn();
const createBlobMock = vi.fn();
const createTreeMock = vi.fn();
const createCommitMock = vi.fn();
const updateRefMock = vi.fn();
const deleteRefMock = vi.fn();
const pullsCreateMock = vi.fn();
const pullsUpdateMock = vi.fn();

vi.mock('octokit', () => {
  class FakeApp {
    async getInstallationOctokit() {
      return {
        rest: {
          pulls: { create: pullsCreateMock, update: pullsUpdateMock },
          git: {
            getRef: getRefMock,
            getCommit: getCommitMock,
            getTree: getTreeMock,
            createRef: createRefMock,
            createBlob: createBlobMock,
            createTree: createTreeMock,
            createCommit: createCommitMock,
            updateRef: updateRefMock,
            deleteRef: deleteRefMock,
          },
        },
      };
    }
  }
  return { App: FakeApp };
});

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
const originalEnv: Record<string, string | undefined> = {};

describe('POST /api/proposals (promote)', () => {
  let authorId: string;
  let roomId: string;
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  beforeEach(async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';

    for (const m of [getRefMock, getCommitMock, getTreeMock, createRefMock, createBlobMock, createTreeMock, createCommitMock, updateRefMock, deleteRefMock, pullsCreateMock, pullsUpdateMock]) {
      m.mockReset();
    }
    getRefMock.mockResolvedValue({ data: { object: { sha: 'base-sha' } } });
    getCommitMock.mockResolvedValue({ data: { tree: { sha: 'tree-sha' } } });
    getTreeMock.mockResolvedValue({ data: { tree: [{ path: 'src/existing.ts', type: 'blob', sha: 'blob-sha' }] } });
    createRefMock.mockResolvedValue({});
    createBlobMock.mockResolvedValue({ data: { sha: 'new-blob-sha' } });
    createTreeMock.mockResolvedValue({ data: { sha: 'new-tree-sha' } });
    createCommitMock.mockResolvedValue({ data: { sha: 'new-commit-sha' } });
    updateRefMock.mockResolvedValue({});
    pullsCreateMock.mockResolvedValue({ data: { number: 99, html_url: 'https://github.com/o/r/pull/99', head: { sha: 'new-commit-sha' } } });

    authorId = await makeContributor();
    contributorIds.push(authorId);
    roomId = await makeRoom({ maintainers: [authorId] });
    roomIds.push(roomId);
    currentContributorId = authorId;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) process.env[key] = originalEnv[key];
    await cleanup({ proposalIds: proposalIds.splice(0), roomIds: roomIds.splice(0), contributorIds: contributorIds.splice(0) });
  });

  async function importRoute() {
    const mod = await import('@/app/api/proposals/route');
    return mod.POST;
  }

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      roomId,
      parentProposalIds: [],
      intentSummary: 'add a feature',
      diffRef: JSON.stringify({ files: [{ path: 'src/new.ts', content: 'export const x = 1;', changeType: 'add' }] }),
      baseRef: 'main',
      headCommit: 'placeholder-head',
      remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false },
      ...overrides,
    };
  }

  it('400s listing missing parentProposalIds and writes nothing', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody({ parentProposalIds: ['proposal_missing_x'] })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.missingIds).toEqual(['proposal_missing_x']);
    expect(pullsCreateMock).not.toHaveBeenCalled();
  });

  it('opens a real PR and stores prNumber/prUrl/headCommit/baseSha on success', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    proposalIds.push(json.proposal.id);

    expect(json.version.prNumber).toBe(99);
    expect(json.version.prUrl).toBe('https://github.com/o/r/pull/99');
    expect(json.version.headCommit).toBe('new-commit-sha');
    expect(json.version.baseSha).toBe('base-sha');
  });

  it('converts a fenced-style unified diff to structured files server-side and still opens a real PR', async () => {
    const unifiedDiff = '--- /dev/null\n+++ b/src/agent-drafted.ts\n@@ -0,0 +1,1 @@\n+export const fromAgent = true;\n';
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody({ diffRef: unifiedDiff })));
    expect(res.status).toBe(201);
    const json = await res.json();
    proposalIds.push(json.proposal.id);
    expect(json.version.prNumber).toBe(99);
    expect(createBlobMock).toHaveBeenCalled();
  });

  it('rejects a diff touching .github/ with 400 and leaves no orphan proposal/version rows', async () => {
    const badDiff = JSON.stringify({
      files: [{ path: '.github/workflows/ci.yml', content: 'evil: true', changeType: 'add' }],
    });
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody({ diffRef: badDiff })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.rejectedPaths).toEqual(['.github/workflows/ci.yml']);
    expect(pullsCreateMock).not.toHaveBeenCalled();

    // No orphan rows: nothing under this room should have been left behind.
    const rows = await db.select().from(proposals).where(eq(proposals.roomId, roomId));
    expect(rows).toHaveLength(0);
  });

  it('rolls back the DB rows and closes/deletes GitHub state when opening the PR fails after the branch was created', async () => {
    pullsCreateMock.mockRejectedValueOnce(new Error('GitHub is down'));

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(502);
    expect(deleteRefMock).toHaveBeenCalled();

    const rows = await db.select().from(proposals).where(eq(proposals.roomId, roomId));
    expect(rows).toHaveLength(0);
  });

  // The ref is created early inside createBranchAndApplyDiff, well before
  // the blob/tree/commit calls. A failure in the middle used to leave a
  // dangling proposal/* branch because the route only marked the branch as
  // created once the whole helper returned.
  it('deletes the branch when the apply fails after the ref was already created', async () => {
    createBlobMock.mockRejectedValueOnce(new Error('blob upload failed'));

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(502);

    expect(createRefMock).toHaveBeenCalledTimes(1);
    const createdRef: string = createRefMock.mock.calls[0][0].ref; // refs/heads/proposal/<id>
    expect(deleteRefMock).toHaveBeenCalledTimes(1);
    expect(deleteRefMock.mock.calls[0][0].ref).toBe(createdRef.replace('refs/', ''));

    const rows = await db.select().from(proposals).where(eq(proposals.roomId, roomId));
    expect(rows).toHaveLength(0);
  });

  // Authoritative baseSha: the route used to resolve the ref itself and
  // then ignore the SHA the apply step actually committed on top of, so a
  // branch advancing in between produced a stored baseSha that disagreed
  // with the commit's real parent.
  it('stores the baseSha the apply step actually used, even if the branch advances', async () => {
    // First resolution is what the apply step sees and commits onto; any
    // later resolution returns an advanced tip.
    getRefMock.mockReset();
    getRefMock.mockResolvedValueOnce({ data: { object: { sha: 'sha-at-apply-time' } } });
    getRefMock.mockResolvedValue({ data: { object: { sha: 'sha-after-branch-advanced' } } });

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    proposalIds.push(json.proposal.id);

    const committedParent = createCommitMock.mock.calls[0][0].parents[0];
    expect(committedParent).toBe('sha-at-apply-time');
    expect(json.version.baseSha).toBe(committedParent);

    // The route no longer resolves the ref on its own; only the apply step
    // does, which is what makes the two values impossible to disagree.
    expect(getRefMock).toHaveBeenCalledTimes(1);
  });

  it('publishes the version only after the PR exists', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    proposalIds.push(json.proposal.id);

    expect(json.version.status).toBe('published');

    const [row] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.versionId, json.version.versionId))
      .limit(1);
    expect(row.status).toBe('published');
    expect(row.prNumber).toBe(99);
  });
});
