// Proposal diff format. The design doc leaves diffRef's exact shape
// unspecified ("diffRef: string"); this project stores diffRef as a JSON
// string encoding a small structured file-change list rather than a
// unified-diff patch, because promote applies it directly via the Git Data
// API (github.ts createBranchAndApplyDiff) rather than parsing patch hunks.
// Flagged as a design-doc gap in the task report.
import { z } from 'zod';
import { normalizeRepoPath } from './repoPath';

export const diffFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  changeType: z.enum(['add', 'modify', 'delete']),
});

export const diffSchema = z.object({
  files: z.array(diffFileSchema).min(1),
});

export type ProposalDiff = z.infer<typeof diffSchema>;

export interface ParseDiffResult {
  ok: boolean;
  diff?: ProposalDiff;
  error?: string;
}

export function parseDiffRef(diffRef: string): ParseDiffResult {
  let json: unknown;
  try {
    json = JSON.parse(diffRef);
  } catch {
    return { ok: false, error: 'diffRef is not valid JSON' };
  }
  const parsed = diffSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  // Paths are canonicalized here so the write-path deny-list downstream
  // never has to reason about "./x" vs "x" vs "a//b".
  return {
    ok: true,
    diff: { files: parsed.data.files.map((f) => ({ ...f, path: normalizeRepoPath(f.path) })) },
  };
}

export function serializeDiff(diff: ProposalDiff): string {
  return JSON.stringify(diff);
}
