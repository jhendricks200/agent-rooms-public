// Unified-diff construction.
//
// The canonical stored artifact (lib/diff.ts) is a whole-file content list,
// because that is what promote applies through the Git Data API. That shape
// is correct for *writing* and useless for *reading*: a reader handed the
// resulting file has to diff it mentally against a parent they cannot see.
// This module turns (before, after) into a real unified diff so the proposal
// page can show what actually moved.
//
// The algorithm is a plain line-level LCS. Proposal diffs in this product are
// single files of tens to hundreds of lines, so the O(n*m) table is cheap and
// its output is minimal, which a heuristic diff is not. LCS_CELL_LIMIT is a
// hard guard: beyond it we emit a whole-file replacement (every old line
// removed, every new line added), which is still a truthful diff, just a
// coarse one.

export const LCS_CELL_LIMIT = 4_000_000;
export const DEFAULT_CONTEXT_LINES = 3;

export type PatchLineKind = 'add' | 'remove' | 'context';

interface Op {
  kind: PatchLineKind;
  text: string;
}

/** Splits file content into lines, dropping the single empty element a
 * trailing newline produces. Both sides are treated identically, so a file
 * that gains or loses only its trailing newline reads as unchanged rather
 * than as a spurious blank-line edit. */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(before: string[], after: string[]): Op[] {
  // Trim the common prefix/suffix first: it is the common case for a remix
  // (a few lines changed in the middle of a file) and it keeps the LCS table
  // small enough to matter.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'context', text: before[i] });

  if (a.length === 0 || b.length === 0 || a.length * b.length > LCS_CELL_LIMIT) {
    for (const text of a) ops.push({ kind: 'remove', text });
    for (const text of b) ops.push({ kind: 'add', text });
  } else {
    // table[i][j] = LCS length of a[i..] and b[j..]
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'context', text: a[i] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        ops.push({ kind: 'remove', text: a[i] });
        i++;
      } else {
        ops.push({ kind: 'add', text: b[j] });
        j++;
      }
    }
    while (i < a.length) ops.push({ kind: 'remove', text: a[i++] });
    while (j < b.length) ops.push({ kind: 'add', text: b[j++] });
  }

  for (let i = endBefore; i < before.length; i++) ops.push({ kind: 'context', text: before[i] });
  return ops;
}

export interface PatchStats {
  adds: number;
  removes: number;
}

export function patchStats(ops: Op[]): PatchStats {
  let adds = 0;
  let removes = 0;
  for (const op of ops) {
    if (op.kind === 'add') adds++;
    else if (op.kind === 'remove') removes++;
  }
  return { adds, removes };
}

/**
 * Builds a standard unified diff for one file, with `--- a/<path>` /
 * `+++ b/<path>` headers and `@@ -old,count +new,count @@` hunk headers.
 * Returns null when the two sides are identical: a modify entry whose content
 * matches the base is not a change, and printing an empty patch for it would
 * be less honest than saying nothing moved.
 */
export function buildUnifiedPatch(
  path: string,
  before: string,
  after: string,
  context: number = DEFAULT_CONTEXT_LINES,
): string | null {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffOps(beforeLines, afterLines);
  const { adds, removes } = patchStats(ops);
  if (adds === 0 && removes === 0) return null;

  // Indices of every changed op, expanded by `context` lines on each side and
  // merged where the windows touch.
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'context') changed.push(index);
  });

  const ranges: Array<{ from: number; to: number }> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  // Walk the op list once, tracking each side's 1-based line cursor, so hunk
  // headers carry real line numbers rather than invented ones.
  let oldLine = 1;
  let newLine = 1;
  const oldStarts: number[] = [];
  const newStarts: number[] = [];
  for (const op of ops) {
    oldStarts.push(oldLine);
    newStarts.push(newLine);
    if (op.kind !== 'add') oldLine++;
    if (op.kind !== 'remove') newLine++;
  }

  for (const range of ranges) {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = range.from; i <= range.to; i++) {
      const op = ops[i];
      if (op.kind === 'add') {
        newCount++;
        body.push(`+${op.text}`);
      } else if (op.kind === 'remove') {
        oldCount++;
        body.push(`-${op.text}`);
      } else {
        oldCount++;
        newCount++;
        body.push(` ${op.text}`);
      }
    }
    const oldStart = oldCount === 0 ? oldStarts[range.from] - 1 : oldStarts[range.from];
    const newStart = newCount === 0 ? newStarts[range.from] - 1 : newStarts[range.from];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }

  return out.join('\n');
}
