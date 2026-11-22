// Parses an agent reply for a promotable draft: an intent line, an artifact
// (either a fenced unified diff or a fenced structured JSON file-list), and
// remix note bullets. Matches the shape the system prompt in
// src/app/api/agent/message/route.ts asks the model to produce.
//
// Draft format unification: the system prompt instructs the model to
// produce structured JSON output ({"files": [...]}) since that is what
// promote can apply directly, but models routinely revert to a familiar
// ```diff fenced unified diff instead. Both are accepted here; promote
// itself (api/proposals/route.ts) is responsible for converting a fenced
// unified diff into the structured format server-side via
// lib/unifiedDiff.ts before applying it, so a sidebar-drafted promote in
// either shape engages the real PR path rather than silently falling back
// to the no-PR stub path.
//
// Recognition is deliberately generous. The promote gesture is the whole
// product, so an agent reply that plainly carries a change must surface a
// promote affordance even when the model fenced it as ```jsonc, ```patch,
// or with no language tag at all, and even when it forgot the "Intent:"
// prefix. A draft the parser fails to see is a promote the user cannot
// perform.
import { diffSchema } from './diff';
import { convertUnifiedDiffToFiles } from './unifiedDiff';

export interface DraftFile {
  path: string;
  changeType: 'add' | 'modify' | 'delete';
}

export interface ParsedAgentDraft {
  intentSummary: string;
  diffRef: string;
  bullets: string[];
  /** Changed files, for the "Ready to promote" card's file list. */
  files: DraftFile[];
  /** Which shape the agent emitted, for copy that has to name it. */
  format: 'structured' | 'unified-diff';
}

interface Fence {
  lang: string;
  body: string;
}

function extractFences(text: string): Fence[] {
  const fences: Fence[] = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    fences.push({ lang: match[1].toLowerCase(), body: match[2].trim() });
  }
  return fences;
}

function asStructured(body: string): string | null {
  try {
    const parsed = diffSchema.safeParse(JSON.parse(body));
    return parsed.success ? JSON.stringify(parsed.data) : null;
  } catch {
    return null;
  }
}

function looksLikeUnifiedDiff(body: string): boolean {
  return /^---\s/m.test(body) && /^\+\+\+\s/m.test(body);
}

// Display-only path extraction for a unified diff the strict converter
// rejects. The card still lists what the change touches; promote itself
// remains free to 422 on a diff it cannot apply.
function pathsFromUnifiedDiff(body: string): DraftFile[] {
  const files: DraftFile[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const plus = lines[i].match(/^\+\+\+\s+(?:b\/)?(\S+)/);
    if (!plus) continue;
    const minus = lines[i - 1]?.match(/^---\s+(?:a\/)?(\S+)/);
    const oldPath = minus?.[1] ?? '';
    const newPath = plus[1];
    if (newPath === '/dev/null') {
      if (oldPath && oldPath !== '/dev/null') files.push({ path: oldPath, changeType: 'delete' });
      continue;
    }
    files.push({ path: newPath, changeType: oldPath === '/dev/null' ? 'add' : 'modify' });
  }
  return files;
}

function extractIntent(text: string, withoutFences: string): string {
  const intentMatch = text.match(/Intent:\s*(.+)/);
  if (intentMatch && intentMatch[1].trim()) return intentMatch[1].trim();

  // No "Intent:" prefix. Fall back to the reply's first real sentence so
  // the promote modal opens with a filled intent rather than an empty
  // required field the user has to invent copy for.
  const firstLine = withoutFences
    .split(/\n+/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .find((line) => line.length > 0 && !/^remix notes:/i.test(line));
  if (!firstLine) return '';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0].trim();
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}

export function parseAgentDraft(text: string): ParsedAgentDraft | null {
  const fences = extractFences(text);
  if (fences.length === 0) return null;

  let diffRef: string | null = null;
  let format: ParsedAgentDraft['format'] | null = null;
  let files: DraftFile[] = [];

  // Structured JSON first: it is what promote applies directly, so it wins
  // over a unified diff if the model somehow emitted both.
  for (const fence of fences) {
    if (fence.lang && !['json', 'jsonc', 'json5', ''].includes(fence.lang)) continue;
    const structured = asStructured(fence.body);
    if (structured) {
      diffRef = structured;
      format = 'structured';
      files = (JSON.parse(structured) as { files: DraftFile[] }).files.map((f) => ({
        path: f.path,
        changeType: f.changeType,
      }));
      break;
    }
  }

  if (diffRef === null) {
    for (const fence of fences) {
      const isDiffFence = ['diff', 'patch'].includes(fence.lang);
      if (!isDiffFence && !(fence.lang === '' && looksLikeUnifiedDiff(fence.body))) continue;
      diffRef = fence.body;
      format = 'unified-diff';
      const converted = convertUnifiedDiffToFiles(fence.body);
      files = converted.ok && converted.diff
        ? converted.diff.files.map((f) => ({ path: f.path, changeType: f.changeType }))
        : pathsFromUnifiedDiff(fence.body);
      break;
    }
  }

  if (!diffRef || !format) return null;

  const withoutFences = text.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, '').trim();
  const intentSummary = extractIntent(text, withoutFences);

  const notesSection = withoutFences.split(/Remix notes:/i)[1] ?? '';
  const bullets = notesSection
    .split('\n')
    .map((line) => line.replace(/^[\s*-]+/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .slice(0, 6);

  return { intentSummary, diffRef, bullets, files, format };
}

/**
 * The agent reply with its fenced artifact removed. When a draft parses,
 * the "Ready to promote" card stands in for the raw blob (the comp shows
 * prose plus the card, never a wall of JSON), and the full diff is still
 * shown in the promote modal before anything is published.
 */
export function draftProse(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
