import { describe, expect, it } from 'vitest';
import { buildUnifiedPatch, splitLines } from '@/lib/patch';

function counts(patch: string) {
  const lines = patch.split('\n');
  return {
    adds: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removes: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
    hunks: lines.filter((l) => l.startsWith('@@')).length,
  };
}

describe('splitLines', () => {
  it('drops only the empty element a trailing newline produces', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('buildUnifiedPatch', () => {
  it('returns null when nothing moved', () => {
    expect(buildUnifiedPatch('a.js', 'x\ny\n', 'x\ny\n')).toBeNull();
    // A trailing-newline-only difference is not treated as an edit.
    expect(buildUnifiedPatch('a.js', 'x\ny\n', 'x\ny')).toBeNull();
  });

  it('reports one add and one remove for a single changed line', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const after = ['a', 'b', 'c', 'CHANGED', 'e', 'f', 'g'].join('\n');
    const patch = buildUnifiedPatch('src/x.js', before, after);
    expect(patch).not.toBeNull();
    expect(counts(patch as string)).toEqual({ adds: 1, removes: 1, hunks: 1 });
    expect(patch).toContain('--- a/src/x.js');
    expect(patch).toContain('+++ b/src/x.js');
    expect(patch).toContain('-d');
    expect(patch).toContain('+CHANGED');
  });

  it('does not mark unchanged lines as changed', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 30', 'line thirty');
    const patch = buildUnifiedPatch('f.js', before, after) as string;
    const { adds, removes } = counts(patch);
    expect(adds).toBe(1);
    expect(removes).toBe(1);
    // 3 lines of context on each side of one change, and nothing else.
    expect(patch.split('\n').filter((l) => l.startsWith(' ')).length).toBe(6);
  });

  it('emits a separate hunk per distant change', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2', 'L2').replace('l30', 'L30');
    const patch = buildUnifiedPatch('f.js', before, after) as string;
    expect(counts(patch)).toEqual({ adds: 2, removes: 2, hunks: 2 });
  });

  it('writes hunk headers with real 1-based line numbers', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'X', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const patch = buildUnifiedPatch('f.js', before, after) as string;
    const header = patch.split('\n').find((l) => l.startsWith('@@')) as string;
    // change on line 5, three lines of context before it -> starts at line 2
    expect(header).toBe('@@ -2,7 +2,7 @@');
  });

  it('handles pure insertion and pure deletion', () => {
    const inserted = buildUnifiedPatch('f.js', 'a\nb\n', 'a\nnew\nb\n') as string;
    expect(counts(inserted)).toEqual({ adds: 1, removes: 0, hunks: 1 });

    const deleted = buildUnifiedPatch('f.js', 'a\ngone\nb\n', 'a\nb\n') as string;
    expect(counts(deleted)).toEqual({ adds: 0, removes: 1, hunks: 1 });
  });

  it('handles an empty base (every line an add)', () => {
    const patch = buildUnifiedPatch('f.js', '', 'a\nb\nc\n') as string;
    expect(counts(patch)).toEqual({ adds: 3, removes: 0, hunks: 1 });
  });

  it('does not misclassify content lines that begin with + or -', () => {
    const before = 'const a = 1;\n- not a marker\n';
    const after = 'const a = 2;\n- not a marker\n';
    const patch = buildUnifiedPatch('f.js', before, after) as string;
    expect(counts(patch)).toEqual({ adds: 1, removes: 1, hunks: 1 });
    // The unchanged line keeps its leading dash behind a context space.
    expect(patch).toContain(' - not a marker');
  });
});
