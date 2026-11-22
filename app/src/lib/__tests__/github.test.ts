import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mergeMock = vi.fn();
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
const pullsGetMock = vi.fn();
const pullsUpdateMock = vi.fn();

vi.mock('octokit', () => {
  class FakeApp {
    async getInstallationOctokit() {
      return {
        rest: {
          pulls: { merge: mergeMock, create: pullsCreateMock, get: pullsGetMock, update: pullsUpdateMock },
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

import {
  mergePullRequest,
  createBranchAndApplyDiff,
  DiffApplyError,
  PathPolicyError,
  findForbiddenPaths,
  openPullRequest,
  getPullRequest,
  closePullRequest,
  splitRepoRef,
  getRef,
  deleteBranch,
} from '@/lib/github';

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;

describe('github.mergePullRequest', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';
    mergeMock.mockReset();
    getRefMock.mockReset();
    getCommitMock.mockReset();
    getTreeMock.mockReset();
    createRefMock.mockReset();
    createBlobMock.mockReset();
    createTreeMock.mockReset();
    createCommitMock.mockReset();
    updateRefMock.mockReset();
    deleteRefMock.mockReset();
    pullsCreateMock.mockReset();
    pullsGetMock.mockReset();
    pullsUpdateMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) process.env[key] = originalEnv[key];
  });

  it('rejects the merge when the PR head has moved since promotion (mocked 409 from octokit)', async () => {
    mergeMock.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));

    const result = await mergePullRequest({
      owner: 'agent-rooms',
      repo: 'demo-room',
      pullNumber: 42,
      expectedHeadCommit: 'stale-sha',
    });

    expect(result.merged).toBe(false);
    expect(result.stubbed).toBe(false);
    expect(result.message).toMatch(/head moved/i);
    expect(mergeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'stale-sha', pull_number: 42 }),
    );
  });

  it('merges successfully when the head matches', async () => {
    mergeMock.mockResolvedValueOnce({ data: { merged: true, sha: 'current-sha', message: 'ok' } });

    const result = await mergePullRequest({
      owner: 'agent-rooms',
      repo: 'demo-room',
      pullNumber: 42,
      expectedHeadCommit: 'current-sha',
    });

    expect(result.merged).toBe(true);
    expect(result.sha).toBe('current-sha');
  });

  it('gracefully stubs the merge when GITHUB_APP credentials are absent', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;

    const result = await mergePullRequest({
      owner: 'agent-rooms',
      repo: 'demo-room',
      pullNumber: 42,
      expectedHeadCommit: 'current-sha',
    });

    expect(result.stubbed).toBe(true);
    expect(result.merged).toBe(false);
    expect(mergeMock).not.toHaveBeenCalled();
  });
});

describe('github.splitRepoRef', () => {
  it('splits an owner/repo githubRepoRef', () => {
    expect(splitRepoRef('jhendricks200/agent-rooms-nightmarket')).toEqual({
      owner: 'jhendricks200',
      repo: 'agent-rooms-nightmarket',
    });
  });

  it('throws on a malformed ref', () => {
    expect(() => splitRepoRef('not-a-valid-ref')).toThrow();
  });
});

describe('github.createBranchAndApplyDiff', () => {
  const ENV_KEYS2 = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
  const originalEnv2: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS2) originalEnv2[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';

    getRefMock.mockResolvedValue({ data: { object: { sha: 'base-sha' } } });
    getCommitMock.mockResolvedValue({ data: { tree: { sha: 'tree-sha' } } });
    getTreeMock.mockResolvedValue({
      data: { tree: [{ path: 'src/app.js', type: 'blob', sha: 'blob-sha' }] },
    });
    createRefMock.mockResolvedValue({});
    createBlobMock.mockResolvedValue({ data: { sha: 'new-blob-sha' } });
    createTreeMock.mockResolvedValue({ data: { sha: 'new-tree-sha' } });
    createCommitMock.mockResolvedValue({ data: { sha: 'new-commit-sha' } });
    updateRefMock.mockResolvedValue({});
  });

  afterEach(() => {
    for (const key of ENV_KEYS2) process.env[key] = originalEnv2[key];
  });

  it('applies a modify diff cleanly and returns the new commit sha', async () => {
    const result = await createBranchAndApplyDiff(
      'jhendricks200',
      'agent-rooms-nightmarket',
      'proposal/p1',
      'main',
      [{ path: 'src/app.js', content: 'export const x = 1;', changeType: 'modify' }],
      'apply proposal diff',
    );

    expect(result.ok).toBe(true);
    expect(result.commitSha).toBe('new-commit-sha');
    expect(createCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ parents: ['base-sha'], tree: 'new-tree-sha' }),
    );
    expect(updateRefMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/proposal/p1', sha: 'new-commit-sha' }),
    );
  });

  it('throws DiffApplyError when a modify target does not exist in the base tree (context mismatch)', async () => {
    await expect(
      createBranchAndApplyDiff(
        'jhendricks200',
        'agent-rooms-nightmarket',
        'proposal/p2',
        'main',
        [{ path: 'src/missing.js', content: 'x', changeType: 'modify' }],
        'apply proposal diff',
      ),
    ).rejects.toThrow(DiffApplyError);
  });

  it('throws DiffApplyError when an add target already exists', async () => {
    await expect(
      createBranchAndApplyDiff(
        'jhendricks200',
        'agent-rooms-nightmarket',
        'proposal/p3',
        'main',
        [{ path: 'src/app.js', content: 'x', changeType: 'add' }],
        'apply proposal diff',
      ),
    ).rejects.toThrow(DiffApplyError);
  });

  it('returns the resolved baseSha alongside the commit sha on success', async () => {
    const result = await createBranchAndApplyDiff(
      'jhendricks200',
      'agent-rooms-nightmarket',
      'proposal/p4',
      'main',
      [{ path: 'src/app.js', content: 'x', changeType: 'modify' }],
      'apply proposal diff',
    );
    expect(result.baseSha).toBe('base-sha');
  });
});

describe('github path policy on repo writes', () => {
  const ENV_KEYS4 = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
  const originalEnv4: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS4) originalEnv4[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';
    getRefMock.mockReset();
    getTreeMock.mockReset();
    createBlobMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS4) process.env[key] = originalEnv4[key];
  });

  it('flags every rejected path in a single findForbiddenPaths call', () => {
    const rejected = findForbiddenPaths([
      { path: '.github/workflows/ci.yml', content: 'x', changeType: 'add' },
      { path: '.git/config', content: 'x', changeType: 'add' },
      { path: '../../etc/passwd', content: 'x', changeType: 'add' },
      { path: '/etc/passwd', content: 'x', changeType: 'add' },
      { path: 'package.json', content: 'x', changeType: 'modify' },
      { path: 'package-lock.json', content: 'x', changeType: 'modify' },
      { path: '.env', content: 'x', changeType: 'add' },
      { path: 'src/fine.ts', content: 'x', changeType: 'add' },
    ]);
    expect(rejected).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml',
        '.git/config',
        '../../etc/passwd',
        '/etc/passwd',
        'package.json',
        'package-lock.json',
        '.env',
      ]),
    );
    expect(rejected).not.toContain('src/fine.ts');
  });

  it('allows a nested dotfile that is not at repo root (only root dotfiles are rejected)', () => {
    const rejected = findForbiddenPaths([{ path: 'src/config/.keep', content: '', changeType: 'add' }]);
    expect(rejected).toEqual([]);
  });

  // Normalization regressions. Every one of these was ALLOWED by the raw
  // startsWith / exact-equality rules: a leading "./", a nested manifest,
  // or a different capitalization walked straight through the deny-list.
  it.each([
    ['./.github/workflows/pwn.yml', 'leading ./ before a .github path'],
    ['.//.github/workflows/pwn.yml', 'duplicate slash before a .github path'],
    ['././.github/workflows/pwn.yml', 'repeated ./ segments'],
    ['.GitHub/workflows/x.yml', 'capitalized .github directory'],
    ['.GIT/config', 'capitalized .git directory'],
    ['./.env', 'leading ./ before a root dotfile'],
    ['./.git/config', 'leading ./ before a .git path'],
    ['./package.json', 'leading ./ before the root manifest'],
    ['packages/app/package.json', 'nested package manifest'],
    ['packages/app/package-lock.json', 'nested lockfile'],
    ['src/../.env', 'traversal back to a root dotfile'],
    ['..\\.env', 'backslash separator'],
    ['a/./../../etc/passwd', 'traversal through . segments'],
  ])('rejects %s (%s)', (path) => {
    const rejected = findForbiddenPaths([{ path, content: 'x', changeType: 'add' }]);
    expect(rejected).toEqual([path]);
  });

  it.each([
    'src/fine.ts',
    'src/config/.keep',
    'docs/packages/notes.md',
    'src/mypackage.json.ts',
  ])('still allows the legitimate path %s', (path) => {
    expect(findForbiddenPaths([{ path, content: 'x', changeType: 'add' }])).toEqual([]);
  });

  it('blocks a normalized-equivalent .github path in createBranchAndApplyDiff before any GitHub call', async () => {
    await expect(
      createBranchAndApplyDiff(
        'jhendricks200',
        'agent-rooms-nightmarket',
        'proposal/p6',
        'main',
        [{ path: './.github/workflows/pwn.yml', content: 'x', changeType: 'add' }],
        'apply proposal diff',
      ),
    ).rejects.toThrow(PathPolicyError);
    expect(createBlobMock).not.toHaveBeenCalled();
    expect(getRefMock).not.toHaveBeenCalled();
  });

  it('createBranchAndApplyDiff throws PathPolicyError before any blob is created', async () => {
    await expect(
      createBranchAndApplyDiff(
        'jhendricks200',
        'agent-rooms-nightmarket',
        'proposal/p5',
        'main',
        [{ path: '.github/workflows/evil.yml', content: 'x', changeType: 'add' }],
        'apply proposal diff',
      ),
    ).rejects.toThrow(PathPolicyError);
    expect(createBlobMock).not.toHaveBeenCalled();
    expect(getRefMock).not.toHaveBeenCalled();
  });
});

describe('github.getRef / github.deleteBranch', () => {
  const ENV_KEYS5 = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
  const originalEnv5: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS5) originalEnv5[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';
    getRefMock.mockReset();
    deleteRefMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS5) process.env[key] = originalEnv5[key];
  });

  it('resolves a branch name to its current commit sha', async () => {
    getRefMock.mockResolvedValueOnce({ data: { object: { sha: 'resolved-sha' } } });
    const sha = await getRef('o', 'r', 'main');
    expect(sha).toBe('resolved-sha');
    expect(getRefMock).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main' }));
  });

  it('deletes a branch', async () => {
    deleteRefMock.mockResolvedValueOnce({});
    await deleteBranch('o', 'r', 'proposal/p1');
    expect(deleteRefMock).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/proposal/p1' }));
  });

  it('swallows a 404 when the branch is already gone', async () => {
    deleteRefMock.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(deleteBranch('o', 'r', 'proposal/gone')).resolves.toBeUndefined();
  });

  it('is a no-op when credentials are absent', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    await deleteBranch('o', 'r', 'proposal/p1');
    expect(deleteRefMock).not.toHaveBeenCalled();
  });
});

describe('github.openPullRequest / getPullRequest / closePullRequest', () => {
  const ENV_KEYS3 = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] as const;
  const originalEnv3: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS3) originalEnv3[key] = process.env[key];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
    process.env.GITHUB_APP_INSTALLATION_ID = '123';
  });

  afterEach(() => {
    for (const key of ENV_KEYS3) process.env[key] = originalEnv3[key];
  });

  it('opens a PR and returns number/url/headSha', async () => {
    pullsCreateMock.mockResolvedValueOnce({
      data: { number: 7, html_url: 'https://github.com/o/r/pull/7', head: { sha: 'head-sha' } },
    });

    const pr = await openPullRequest('o', 'r', 'proposal/p1', 'main', 'Add a feature', 'body text');
    expect(pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7', headSha: 'head-sha' });
    expect(pullsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'proposal/p1', base: 'main', title: 'Add a feature', body: 'body text' }),
    );
  });

  it('reads current PR head sha for the head-moved check', async () => {
    pullsGetMock.mockResolvedValueOnce({
      data: { number: 7, html_url: 'https://github.com/o/r/pull/7', head: { sha: 'moved-sha' }, state: 'open' },
    });

    const pr = await getPullRequest('o', 'r', 7);
    expect(pr.headSha).toBe('moved-sha');
  });

  it('closes a PR without merging on reject', async () => {
    pullsUpdateMock.mockResolvedValueOnce({ data: { state: 'closed' } });

    await closePullRequest('o', 'r', 7);
    expect(pullsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 7, state: 'closed' }),
    );
    expect(mergeMock).not.toHaveBeenCalled();
  });
});
