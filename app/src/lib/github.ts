// GitHub service module. Owns every call to the GitHub REST API so adoption
// integrity (SHA-pinned PR merge, design doc "Adoption integrity") has a
// single choke point.
//
// Auth is a GitHub App, credentials from env:
//   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID
// When any of these are absent, GitHub-touching functions return a stub
// result instead of calling GitHub, so local dev and tests without
// credentials still work.
//
// Design-doc gap found while building this: the app "agent-rooms-dev" is
// installed on the Agent-Rooms org (with access to all repos) with permissions
// contents:write, metadata:read, pull_requests:write only. GitHub Apps
// cannot create repositories on an org account this way (that needs an
// Administration:write account-level permission the app does not have;
// verified live, POST /user/repos returns 403 "Resource not accessible by
// integration" with these creds). Repo creation in createRoomRepo therefore
// shells out to the `gh` CLI using the user's own already-authenticated gh
// session, not the GitHub App. Every other operation (seeding, branches,
// commits, PRs, merges) goes through the GitHub App as designed.

// `octokit` is imported dynamically (not as a static import) because tsx,
// when run as a CLI script rather than through Next's bundler, transpiles
// static imports to CommonJS require() calls; @octokit/app is ESM-only with
// no "exports" map, so a plain require() of it fails under Node 25 with
// ERR_PACKAGE_PATH_NOT_EXPORTED. A real dynamic import() resolves it fine
// (verified live) and works identically under Next's bundler too.
import type { App as AppType } from 'octokit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRepoPath, repoPathBasename } from './repoPath';

const execFileAsync = promisify(execFile);

export interface MergeParams {
  owner: string;
  repo: string;
  pullNumber: number;
  /** PR head SHA expected at merge time. Passed as the `sha` param to
   * GitHub's merge endpoint so the merge fails if the head has moved
   * since promotion (design doc, "Adoption integrity"). */
  expectedHeadCommit: string;
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergeResult {
  merged: boolean;
  stubbed: boolean;
  sha?: string;
  message: string;
}

export function credsPresent(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID,
  );
}

async function getInstallationOctokit() {
  const { App } = await import('octokit');
  const app = new (App as typeof AppType)({
    appId: process.env.GITHUB_APP_ID as string,
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY as string).replace(/\\n/g, '\n'),
  });
  return app.getInstallationOctokit(Number(process.env.GITHUB_APP_INSTALLATION_ID));
}

/**
 * SHA-pinned PR merge. Fails (does not merge) if the PR's current head does
 * not match expectedHeadCommit, per the design doc's adoption-integrity
 * requirement: "the room can never merge code different from what was
 * promoted, hashed, and credited."
 */
export async function mergePullRequest(params: MergeParams): Promise<MergeResult> {
  if (!credsPresent()) {
    return {
      merged: false,
      stubbed: true,
      message: 'GITHUB_APP credentials absent; merge call stubbed, not sent to GitHub.',
    };
  }

  const octokit = await getInstallationOctokit();

  try {
    const response = await octokit.rest.pulls.merge({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      sha: params.expectedHeadCommit,
      commit_title: params.commitTitle,
      commit_message: params.commitMessage,
    });

    return {
      merged: response.data.merged,
      stubbed: false,
      sha: response.data.sha,
      message: response.data.message,
    };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) {
      return {
        merged: false,
        stubbed: false,
        message: 'PR head moved since promotion; merge rejected (expectedHeadCommit mismatch).',
      };
    }
    throw error;
  }
}

export interface CreateRoomRepoResult {
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
}

/**
 * Creates a private repo under the user's account via the `gh` CLI (see
 * file header: the GitHub App cannot create repos on a user account). Not
 * stubbed by credsPresent() since it does not use the App at all; it needs
 * `gh` to be authenticated in the shell, which is a separate precondition
 * checked by attempting the call and surfacing the CLI's own error.
 */
export async function createRoomRepo(
  owner: string,
  repoName: string,
  description: string,
): Promise<CreateRoomRepoResult> {
  await execFileAsync('gh', [
    'repo',
    'create',
    `${owner}/${repoName}`,
    '--private',
    '--description',
    description,
  ]);

  const octokit = credsPresent() ? await getInstallationOctokit() : null;
  if (octokit) {
    const { data } = await octokit.rest.repos.get({ owner, repo: repoName });
    return { owner, repo: repoName, url: data.html_url, defaultBranch: data.default_branch };
  }

  return {
    owner,
    repo: repoName,
    url: `https://github.com/${owner}/${repoName}`,
    defaultBranch: 'main',
  };
}

export interface SeedFile {
  path: string;
  content: string;
}

/**
 * Seeds a brand-new, empty repo with a genesis commit containing `files`.
 * Uses the Contents API one file at a time rather than the Git Data API:
 * a completely empty repo (zero commits, no branch ref) has no tree for
 * the Git Data API's blob/tree endpoints to attach to (verified live:
 * createBlob on a just-created empty repo 409s with "Git Repository is
 * empty"), whereas the Contents API is GitHub's documented path for
 * creating a repo's first commit. The first file call establishes `branch`
 * and every subsequent call commits on top of it, so the last call's
 * commit SHA is the genesis HEAD. Uses the GitHub App installation, since
 * the repo is now accessible to it (the app's installation is configured
 * for repository_selection: all on this account, verified live).
 */
export async function seedGenesisCommit(
  owner: string,
  repo: string,
  branch: string,
  files: SeedFile[],
  message: string,
): Promise<string> {
  if (!credsPresent()) {
    throw new Error('GITHUB_APP credentials absent; cannot seed repo.');
  }
  const octokit = await getInstallationOctokit();

  let lastSha = '';
  for (const [index, file] of files.entries()) {
    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message: index === files.length - 1 ? message : `${message} (${file.path})`,
      content: Buffer.from(file.content, 'utf-8').toString('base64'),
      branch,
    });
    lastSha = data.commit.sha as string;
  }

  return lastSha;
}

export interface ApplyDiffFile {
  path: string;
  content: string; // full new content
  changeType: 'add' | 'modify' | 'delete';
}

export interface ApplyDiffResult {
  ok: true;
  commitSha: string;
  baseSha: string;
}

export class DiffApplyError extends Error {}

/**
 * Path policy on repo writes (design doc, Safety mechanics; findings from
 * the security review). Rejected before any blob is created:
 *   - anything under .github/ or .git/ (workflow/hooks injection)
 *   - any path containing ".." (path traversal)
 *   - absolute paths, and any path containing a backslash
 *   - package.json / package-lock.json anywhere in the tree, by basename,
 *     so a nested manifest (packages/app/package.json) is caught too
 *   - any root-level dotfile (e.g. .env, .npmrc)
 *
 * Every rule runs against the normalized path (lib/repoPath.ts), and
 * directory prefixes are compared case-insensitively, so "./.github/x.yml"
 * and ".GitHub/x.yml" are rejected exactly like ".github/x.yml".
 * Named constant so the policy is one place to audit, not scattered regexes.
 */
export const FORBIDDEN_DIFF_PATH_RULES: Array<{ name: string; test: (rawPath: string) => boolean }> = [
  { name: 'backslash', test: (raw) => raw.includes('\\') },
  { name: 'github-directory', test: (raw) => normalizeRepoPath(raw).toLowerCase().startsWith('.github/') },
  { name: 'git-directory', test: (raw) => normalizeRepoPath(raw).toLowerCase().startsWith('.git/') },
  { name: 'path-traversal', test: (raw) => normalizeRepoPath(raw).split('/').includes('..') },
  { name: 'absolute-path', test: (raw) => normalizeRepoPath(raw).startsWith('/') },
  { name: 'package-json', test: (raw) => repoPathBasename(raw).toLowerCase() === 'package.json' },
  { name: 'package-lock', test: (raw) => repoPathBasename(raw).toLowerCase() === 'package-lock.json' },
  {
    name: 'root-dotfile',
    test: (raw) => {
      const normalized = normalizeRepoPath(raw);
      return !normalized.includes('/') && normalized.startsWith('.');
    },
  },
  { name: 'empty-path', test: (raw) => normalizeRepoPath(raw).length === 0 },
];

export class PathPolicyError extends Error {
  rejectedPaths: string[];
  constructor(rejectedPaths: string[]) {
    super(`diff touches disallowed paths: ${rejectedPaths.join(', ')}`);
    this.rejectedPaths = rejectedPaths;
  }
}

export function findForbiddenPaths(files: ApplyDiffFile[]): string[] {
  const rejected = new Set<string>();
  for (const file of files) {
    for (const rule of FORBIDDEN_DIFF_PATH_RULES) {
      if (rule.test(file.path)) {
        rejected.add(file.path);
      }
    }
  }
  return [...rejected];
}

/** Resolves a branch/ref name to its current commit SHA. Used at promote
 * time to store the resolved baseSha alongside the human-readable baseRef. */
export async function getRef(owner: string, repo: string, ref: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${ref}` });
  return data.object.sha;
}

/**
 * Reads one file's UTF-8 content at an exact commit SHA. Read-only, and the
 * ref is always a pinned SHA in practice, so what comes back is the same
 * bytes the proposal was actually built on top of. Returns null when the
 * path does not exist at that commit, when the blob is not text, or when
 * GITHUB_APP credentials are absent, so the caller can degrade rather than
 * fabricate a base to diff against.
 */
export async function getFileAtCommit(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  if (!credsPresent()) return null;
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file') return null;
    // Files over 1MB come back with encoding 'none' and an empty content
    // field; the blob API serves them in full.
    if (data.encoding === 'base64' && typeof data.content === 'string') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha });
    if (blob.data.encoding !== 'base64') return null;
    return Buffer.from(blob.data.content, 'base64').toString('utf-8');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return null;
    throw error;
  }
}

/** Deletes a branch. Best-effort cleanup after a failed promote; swallows
 * a 404/422 (branch never got created, or was already removed). */
export async function deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
  if (!credsPresent()) return;
  const octokit = await getInstallationOctokit();
  try {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 422) throw error;
  }
}

/**
 * Creates branch `branch` from the tip of `base`, then applies `files` as a
 * single commit via the Git Data API. `modify`/`delete` entries must
 * already exist in the base tree (this is our context-match check, the
 * equivalent of a unified diff's hunk context failing to apply); a missing
 * path throws DiffApplyError so the caller can return a 422. Paths are
 * checked against the path policy above before any blob is created.
 */
export async function createBranchAndApplyDiff(
  owner: string,
  repo: string,
  branch: string,
  base: string,
  files: ApplyDiffFile[],
  message: string,
  hooks?: { onRefCreated?: () => void },
): Promise<ApplyDiffResult> {
  const rejectedPaths = findForbiddenPaths(files);
  if (rejectedPaths.length > 0) {
    throw new PathPolicyError(rejectedPaths);
  }

  const octokit = await getInstallationOctokit();

  const baseRefData = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = baseRefData.data.object.sha;
  const baseGitCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
  const baseTreeSha = baseGitCommit.data.tree.sha;

  const baseTree = await octokit.rest.git.getTree({ owner, repo, tree_sha: baseTreeSha, recursive: 'true' });
  const existingPaths = new Set(baseTree.data.tree.filter((t) => t.type === 'blob').map((t) => t.path));

  for (const file of files) {
    if ((file.changeType === 'modify' || file.changeType === 'delete') && !existingPaths.has(file.path)) {
      throw new DiffApplyError(
        `diff did not apply cleanly against base ${baseSha}: ${file.changeType} target "${file.path}" not found`,
      );
    }
    if (file.changeType === 'add' && existingPaths.has(file.path)) {
      throw new DiffApplyError(
        `diff did not apply cleanly against base ${baseSha}: add target "${file.path}" already exists`,
      );
    }
  }

  // The ref exists on GitHub from here on, well before the commit is
  // built. The caller is told immediately so a failure during blob/tree/
  // commit still gets the branch cleaned up rather than leaving a dangling
  // proposal/* branch behind.
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    hooks?.onRefCreated?.();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422) throw error; // 422 = ref already exists; reuse it
    hooks?.onRefCreated?.();
  }

  const treeEntries = await Promise.all(
    files.map(async (file) => {
      if (file.changeType === 'delete') {
        return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: null };
      }
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: 'utf-8',
      });
      return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha };
    }),
  );

  const newTree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.data.sha,
    parents: [baseSha],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false,
  });

  return { ok: true, commitSha: commit.data.sha, baseSha };
}

export interface OpenPullRequestResult {
  number: number;
  url: string;
  headSha: string;
}

export async function openPullRequest(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<OpenPullRequestResult> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body });
  return { number: data.number, url: data.html_url, headSha: data.head.sha };
}

/** Reads a PR's current state. `merged` and `mergeCommitSha` are what makes
 * a crashed adoption attempt recoverable: a retry asks GitHub whether the
 * merge already happened instead of merging a second time. */
export async function getPullRequest(owner: string, repo: string, pullNumber: number) {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return {
    number: data.number,
    url: data.html_url,
    headSha: data.head.sha,
    state: data.state,
    merged: Boolean(data.merged),
    mergeCommitSha: data.merge_commit_sha ?? null,
  };
}

/** Closes a PR without merging (design doc: "Rejected proposals close the PR without merge"). */
export async function closePullRequest(owner: string, repo: string, pullNumber: number): Promise<void> {
  if (!credsPresent()) return;
  const octokit = await getInstallationOctokit();
  await octokit.rest.pulls.update({ owner, repo, pull_number: pullNumber, state: 'closed' });
}

/** Login of the account (user or org) the GitHub App installation is on. */
export async function getInstallationAccountLogin(): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.apps.getInstallation({
    installation_id: Number(process.env.GITHUB_APP_INSTALLATION_ID),
  });
  const account = data.account as { login?: string } | null;
  if (!account?.login) throw new Error('installation account has no login');
  return account.login;
}

export function splitRepoRef(githubRepoRef: string): { owner: string; repo: string } {
  const [owner, repo] = githubRepoRef.split('/');
  if (!owner || !repo) {
    throw new Error(`githubRepoRef must be "owner/repo", got "${githubRepoRef}"`);
  }
  return { owner, repo };
}
