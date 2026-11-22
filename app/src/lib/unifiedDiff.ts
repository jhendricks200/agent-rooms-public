import type { ProposalDiff } from './diff';
import { normalizeRepoPath } from './repoPath';

export interface ConvertResult {
  ok: boolean;
  diff?: ProposalDiff;
  error?: string;
}

interface FileBlock {
  oldPath: string;
  newPath: string;
  hunkLines: string[]; // all lines after the @@ header(s), across every hunk
  hunkCount: number;
  firstHunkOldStart: number | null;
}

/**
 * Converts a fenced unified-diff (the format the sidebar agent's system
 * prompt asks for, per agentDraft.ts) into the structured {files:[...]}
 * format createBranchAndApplyDiff expects. v0 scope: only whole-file
 * add/modify/delete hunks convert cleanly, since promote applies the
 * result directly against the base tree via the Git Data API rather than
 * patching hunks against existing blob content:
 *   - add: every content line must be a '+' line (no base content exists).
 *   - delete: every content line must be a '-' line.
 *   - modify: exactly one hunk, starting at old line 1, so the
 *     reconstructed content (context + additions, in order) is the
 *     complete new file rather than a partial patch fragment.
 * Anything else returns ok:false with a clear message so the caller can
 * 422 instead of silently applying a partial/corrupt file.
 */
export function convertUnifiedDiffToFiles(diffText: string): ConvertResult {
  const blocks = splitIntoFileBlocks(diffText);
  if (blocks.length === 0) {
    return { ok: false, error: 'no recognizable unified diff file headers (--- / +++) found' };
  }

  const files: ProposalDiff['files'] = [];
  for (const block of blocks) {
    const result = convertFileBlock(block);
    if (!result.ok) return result;
    files.push(result.file!);
  }

  return { ok: true, diff: { files } };
}

function stripPathPrefix(path: string): string {
  // Standard unified-diff a/ b/ prefixes, then canonicalize so the
  // write-path deny-list sees one spelling per path.
  return normalizeRepoPath(normalizeRepoPath(path).replace(/^[ab]\//, ''));
}

function splitIntoFileBlocks(diffText: string): FileBlock[] {
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  const blocks: FileBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('--- ')) {
      const oldHeader = lines[i].slice(4).trim();
      const newHeader = lines[i + 1]?.startsWith('+++ ') ? lines[i + 1].slice(4).trim() : null;
      if (newHeader === null) {
        i += 1;
        continue;
      }
      i += 2;

      const hunkLines: string[] = [];
      let hunkCount = 0;
      let firstHunkOldStart: number | null = null;

      while (i < lines.length && !lines[i].startsWith('--- ')) {
        const hunkHeader = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
        if (hunkHeader) {
          hunkCount += 1;
          if (firstHunkOldStart === null) firstHunkOldStart = Number(hunkHeader[1]);
          i += 1;
          continue;
        }
        hunkLines.push(lines[i]);
        i += 1;
      }

      blocks.push({
        oldPath: oldHeader.split('\t')[0],
        newPath: newHeader.split('\t')[0],
        hunkLines,
        hunkCount,
        firstHunkOldStart,
      });
    } else {
      i += 1;
    }
  }

  return blocks;
}

function convertFileBlock(block: FileBlock): { ok: boolean; file?: ProposalDiff['files'][number]; error?: string } {
  const isAdd = block.oldPath === '/dev/null';
  const isDelete = block.newPath === '/dev/null';
  const path = stripPathPrefix(isAdd ? block.newPath : block.oldPath);

  // Drop trailing blank line vitest/diff tools sometimes leave at EOF.
  const contentLines = block.hunkLines.filter((_, idx) => !(idx === block.hunkLines.length - 1 && block.hunkLines[idx] === ''));

  if (isAdd) {
    const bad = contentLines.find((l) => !l.startsWith('+') && l !== '');
    if (bad) {
      return { ok: false, error: `file "${path}": add diff contains a non-addition line ("${bad}"); partial-file add hunks are not supported in v0` };
    }
    const content = contentLines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
    return { ok: true, file: { path, content, changeType: 'add' } };
  }

  if (isDelete) {
    const bad = contentLines.find((l) => !l.startsWith('-') && l !== '');
    if (bad) {
      return { ok: false, error: `file "${path}": delete diff contains a non-removal line ("${bad}"); partial-file delete hunks are not supported in v0` };
    }
    return { ok: true, file: { path, content: '', changeType: 'delete' } };
  }

  // modify
  if (block.hunkCount !== 1) {
    return {
      ok: false,
      error: `file "${path}": modify diff has ${block.hunkCount} hunks; v0 only converts a single whole-file hunk cleanly`,
    };
  }
  if (block.firstHunkOldStart !== 1) {
    return {
      ok: false,
      error: `file "${path}": modify hunk does not start at line 1 (starts at ${block.firstHunkOldStart}); v0 cannot reconstruct the full file without the missing leading context`,
    };
  }
  const bad = contentLines.find((l) => l !== '' && !l.startsWith('+') && !l.startsWith('-') && !l.startsWith(' '));
  if (bad) {
    return { ok: false, error: `file "${path}": unrecognized diff line ("${bad}")` };
  }
  const content = contentLines
    .filter((l) => l.startsWith('+') || l.startsWith(' '))
    .map((l) => l.slice(1))
    .join('\n');
  return { ok: true, file: { path, content, changeType: 'modify' } };
}
