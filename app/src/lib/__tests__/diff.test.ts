import { describe, it, expect } from 'vitest';
import { parseDiffRef, serializeDiff } from '@/lib/diff';

describe('diff.parseDiffRef', () => {
  it('parses a valid structured diff', () => {
    const diffRef = serializeDiff({
      files: [{ path: 'src/app.js', content: 'export const x = 1;', changeType: 'modify' }],
    });
    const result = parseDiffRef(diffRef);
    expect(result.ok).toBe(true);
    expect(result.diff?.files).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    const result = parseDiffRef('not json');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty files array', () => {
    const result = parseDiffRef(JSON.stringify({ files: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized changeType', () => {
    const result = parseDiffRef(JSON.stringify({ files: [{ path: 'a', content: 'b', changeType: 'rename' }] }));
    expect(result.ok).toBe(false);
  });

  // Path normalization happens at parse time, so the write-path deny-list
  // downstream only ever sees one spelling of a given path.
  it('normalizes redundant path spellings', () => {
    const result = parseDiffRef(
      JSON.stringify({
        files: [
          { path: './src/a.ts', content: 'x', changeType: 'add' },
          { path: 'src//b.ts', content: 'x', changeType: 'add' },
          { path: '././src/c.ts', content: 'x', changeType: 'add' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.diff?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });
});
