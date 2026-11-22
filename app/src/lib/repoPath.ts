// Canonical repo-relative path normalization, shared by the diff parsers
// (lib/diff.ts, lib/unifiedDiff.ts) and the write-path deny-list
// (lib/github.ts). Every path that reaches the policy check must go
// through here first, otherwise trivially equivalent spellings of a
// forbidden path ("./.github/workflows/x.yml", ".GitHub/...",
// "a//..//.env") slip past prefix and equality rules.
//
// Normalization is deliberately conservative: it only removes redundant
// spellings. It never resolves ".." (traversal stays visible to the deny
// rule) and never rewrites backslashes (a backslash is itself rejected,
// since a Windows-style or escaped separator is not a legal repo path and
// would defeat segment-wise checks).
export function normalizeRepoPath(raw: string): string {
  const trimmed = raw.trim();
  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/');
  const kept: string[] = [];
  for (const [index, segment] of segments.entries()) {
    // Drop "." segments, but keep a trailing empty segment situation as-is
    // so "/etc/passwd" still starts with "/" and stays detectably absolute.
    if (segment === '.') continue;
    if (segment === '' && index !== 0) continue;
    kept.push(segment);
  }
  return kept.join('/');
}

export function repoPathBasename(path: string): string {
  const segments = normalizeRepoPath(path).split('/');
  return segments[segments.length - 1] ?? '';
}
