// Server-rendered, syntax-highlighted diff.
//
// diffRef has two shapes in practice. The canonical one, produced by promote
// and consumed by github.ts's createBranchAndApplyDiff, is the structured
// file-change list in lib/diff.ts: {"files":[{path, content, changeType}]}.
// The other is a raw unified-diff patch, which is what the older hand-written
// fixture rows stored. Rendering the structured shape through the unified-diff
// line classifier printed the whole JSON blob as one wall of "context" lines,
// which is what every proposal in the seeded demonstration room looked like
// until this was fixed: the diff is the single thing a would-be forker has to
// read, so it cannot be a JSON dump.
//
// A structured entry carries the file's new content, not a hunk-level delta.
// For an added or deleted file that is the whole truth. For a *modified* file
// it is not: rendering the resulting file as a wall of context lines makes
// the reader diff it in their head against a parent they cannot see, which is
// precisely the cost a proposal card exists to remove. So the caller resolves
// the file's content at the pinned baseSha and hands us a real unified patch
// per modified path (lib/proposalPatch.ts); we render it through the same
// classifier the legacy raw-patch branch uses, with the same +N/−M counts and
// ratio bar.
//
// When no patch could be produced (no credentials, unreadable base, an
// unresolvable SHA) the file falls back to its whole content, explicitly
// labelled as not a diff. A fake diff would be worse than no diff.
//
// Presentation follows design/screen-proposal.html: every file is a
// disclosure, closed on arrival, so the diff reads first as a list of what
// moved and opens only where the reader wants the code. It is built on
// <details> rather than a click handler so it keeps working with no
// JavaScript and this stays a server component.
import { parseDiffRef } from '@/lib/diff';

type LineKind = 'add' | 'remove' | 'context' | 'hunk';

function classifyUnified(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'remove';
  return 'context';
}

function Chevron() {
  return (
    <span className="chev" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 6l4 4 4-4" />
      </svg>
    </span>
  );
}

function DiffLine({ kind, text, num }: { kind: LineKind; text: string; num?: number }) {
  const sign = kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ';
  return (
    <div className={`dline ${kind}${num != null ? ' numbered' : ''}`}>
      {/* A hunk-based diff knows each line's real file position, so the
          gutter shows it instead of a running count that would be wrong the
          moment a hunk skips ahead. */}
      <span className="dnum">{num != null ? num : null}</span>
      <span className="dsign">{sign}</span>
      <span className="dtext">{text.length === 0 ? ' ' : text}</span>
    </div>
  );
}

function Bar({ adds, removes }: { adds: number; removes: number }) {
  const total = adds + removes;
  if (total === 0) return null;
  const p = Math.round((adds / total) * 100);
  return (
    <span className="dbar" aria-hidden="true">
      {p > 0 && <i className="p" style={{ width: `${p}%` }} />}
      {p < 100 && <i className="m" style={{ width: `${100 - p}%` }} />}
    </span>
  );
}

// Split a unified patch into per-file chunks. Falls back to a single chunk
// when the patch carries no file headers, which is what the oldest fixture
// rows look like.
function splitUnified(patch: string): { path: string; lines: string[] }[] {
  const lines = patch.split('\n');
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    const gitHeader = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    const plusHeader = /^\+\+\+ b?\/?(\S+)/.exec(line);
    if (gitHeader) {
      current = { path: gitHeader[2], lines: [] };
      files.push(current);
      continue;
    }
    if (plusHeader && (!current || current.path === '(patch)')) {
      if (current && current.path === '(patch)' && current.lines.length === 0) files.pop();
      current = { path: plusHeader[1], lines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) continue;
    if (!current) {
      current = { path: '(patch)', lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }
  return files.filter((f) => f.lines.length > 0);
}

interface PatchRow {
  kind: LineKind;
  text: string;
  num?: number;
}

/** Classifies a unified patch body into renderable rows, tracking each
 * side's real line number from the hunk headers. */
function readPatch(patch: string): { rows: PatchRow[]; adds: number; removes: number } {
  const rows: PatchRow[] = [];
  let adds = 0;
  let removes = 0;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) continue;
    const kind = classifyUnified(line);
    if (kind === 'hunk') {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = header ? Number(header[1]) : 0;
      newLine = header ? Number(header[2]) : 0;
      rows.push({ kind, text: line });
      continue;
    }
    const text = kind === 'context' ? (line.startsWith(' ') ? line.slice(1) : line) : line.slice(1);
    if (kind === 'add') {
      adds++;
      rows.push({ kind, text, num: newLine++ });
    } else if (kind === 'remove') {
      removes++;
      rows.push({ kind, text, num: oldLine++ });
    } else {
      rows.push({ kind, text, num: newLine });
      oldLine++;
      newLine++;
    }
  }
  return { rows, adds, removes };
}

function PatchLines({ rows, path }: { rows: PatchRow[]; path: string }) {
  return (
    <div className="dlines">
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <div className="dhunk" key={`${path}-${i}`}>
            {row.text}
          </div>
        ) : (
          <DiffLine kind={row.kind} text={row.text} num={row.num} key={`${path}-${i}`} />
        ),
      )}
    </div>
  );
}

export interface DiffViewProps {
  diff: string;
  /** repo-relative path -> unified patch text for `modify` entries. An empty
   * string means the base was read and nothing moved. See lib/proposalPatch.ts. */
  patches?: Record<string, string>;
  /** Why some modify entries have no patch, stated plainly in the fallback. */
  unavailableReason?: string | null;
}

export function DiffView({ diff, patches, unavailableReason }: DiffViewProps) {
  const parsed = parseDiffRef(diff);

  if (parsed.ok && parsed.diff) {
    return (
      <div className="diff">
        {parsed.diff.files.map((file) => {
          const mark = file.changeType === 'add' ? 'add' : file.changeType === 'delete' ? 'del' : 'mod';
          const glyph = file.changeType === 'add' ? '+' : file.changeType === 'delete' ? '−' : '~';
          const patch = file.changeType === 'modify' ? patches?.[file.path] : undefined;

          // A modified file with a resolved base renders as a real diff.
          if (patch != null) {
            const { rows, adds, removes } = readPatch(patch);
            return (
              <details className="dfile" key={file.path}>
                <summary className="dfile-head">
                  <Chevron />
                  <span className={`mk ${mark}`} aria-hidden="true">
                    {glyph}
                  </span>
                  <span className="path">{file.path}</span>
                  <span className="spacer" />
                  {adds === 0 && removes === 0 ? (
                    <span className="n">no change against base</span>
                  ) : (
                    <>
                      {adds > 0 && <span className="n plus">+{adds}</span>}
                      {removes > 0 && <span className="n minus">−{removes}</span>}
                      <Bar adds={adds} removes={removes} />
                    </>
                  )}
                </summary>
                <div className="dfile-body">
                  {rows.length === 0 ? (
                    <p className="dnote">
                      This file is byte-identical to its base commit. Nothing moved.
                    </p>
                  ) : (
                    <PatchLines rows={rows} path={file.path} />
                  )}
                </div>
              </details>
            );
          }

          // Added, deleted, or a modified file whose base could not be read.
          const kind: LineKind =
            file.changeType === 'add' ? 'add' : file.changeType === 'delete' ? 'remove' : 'context';
          const lines = file.content.length > 0 ? file.content.split('\n') : [];
          return (
            <details className="dfile" key={file.path}>
              <summary className="dfile-head">
                <Chevron />
                <span className={`mk ${mark}`} aria-hidden="true">
                  {glyph}
                </span>
                <span className="path">{file.path}</span>
                <span className="spacer" />
                {/* An add or a delete moves every line, so the file's own
                    line count is the true count. A modify with no resolved
                    base has no true count, and is labelled rather than
                    given one. */}
                {kind === 'add' && <span className="n plus">+{lines.length}</span>}
                {kind === 'remove' && <span className="n minus">−{lines.length}</span>}
                {kind === 'context' && <span className="n warn">whole file · {lines.length} lines</span>}
              </summary>
              <div className="dfile-body">
                {kind === 'context' && (
                  <p className="dnote" role="note">
                    <b>Not a diff.</b> The resulting file is shown in full because{' '}
                    {unavailableReason ?? 'its base version could not be resolved'}. Compare it against{' '}
                    the pull request to see what changed.
                  </p>
                )}
                <div className="dlines">
                  {lines.map((line, i) => (
                    <DiffLine kind={kind} text={line} key={`${file.path}-${i}`} />
                  ))}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    );
  }

  // Unified-diff patch text, classified by each line's leading character.
  const files = splitUnified(diff);
  return (
    <div className="diff">
      {files.map((file, fi) => {
        const classified = file.lines.map((line) => ({ kind: classifyUnified(line), text: line }));
        const adds = classified.filter((l) => l.kind === 'add').length;
        const removes = classified.filter((l) => l.kind === 'remove').length;
        return (
          <details className="dfile" key={`${file.path}-${fi}`}>
            <summary className="dfile-head">
              <Chevron />
              <span className="mk mod" aria-hidden="true">
                ~
              </span>
              <span className="path">{file.path}</span>
              <span className="spacer" />
              {adds > 0 && <span className="n plus">+{adds}</span>}
              {removes > 0 && <span className="n minus">−{removes}</span>}
              <Bar adds={adds} removes={removes} />
            </summary>
            <div className="dfile-body">
              <div className="dlines">
                {classified.map((line, i) =>
                  line.kind === 'hunk' ? (
                    <div className="dhunk" key={i}>
                      {line.text}
                    </div>
                  ) : (
                    <DiffLine
                      kind={line.kind}
                      // The leading +/-/space is drawn as the sign column, so
                      // it is stripped from the text itself.
                      text={
                        line.kind === 'context'
                          ? line.text.startsWith(' ')
                            ? line.text.slice(1)
                            : line.text
                          : line.text.slice(1)
                      }
                      key={i}
                    />
                  ),
                )}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}
