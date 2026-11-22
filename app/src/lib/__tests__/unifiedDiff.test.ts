import { describe, it, expect } from 'vitest';
import { convertUnifiedDiffToFiles } from '@/lib/unifiedDiff';

describe('convertUnifiedDiffToFiles', () => {
  it('converts a whole-file add diff', () => {
    const diff = '--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1,2 @@\n+export const x = 1;\n+export const y = 2;\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff!.files).toEqual([
      { path: 'src/x.ts', content: 'export const x = 1;\nexport const y = 2;', changeType: 'add' },
    ]);
  });

  it('converts a whole-file delete diff', () => {
    const diff = '--- a/src/x.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const x = 1;\n-export const y = 2;\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff!.files).toEqual([{ path: 'src/x.ts', content: '', changeType: 'delete' }]);
  });

  it('converts a whole-file modify diff whose single hunk starts at line 1', () => {
    const diff =
      '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n export const x = 1;\n-export const y = 2;\n+export const y = 3;\n+export const z = 4;\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff!.files).toEqual([
      { path: 'src/x.ts', content: 'export const x = 1;\nexport const y = 3;\nexport const z = 4;', changeType: 'modify' },
    ]);
  });

  it('converts multiple files in one diff', () => {
    const diff =
      '--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+export const a = 1;\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,1 @@\n+export const b = 2;\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff!.files).toHaveLength(2);
    expect(result.diff!.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('rejects a modify hunk that does not start at line 1 (partial-file hunk, cannot reconstruct)', () => {
    const diff = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -5,2 +5,2 @@\n-old line\n+new line\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not start at line 1/);
  });

  it('rejects a modify diff with more than one hunk', () => {
    const diff =
      '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hunks/);
  });

  it('rejects text with no recognizable diff headers', () => {
    const result = convertUnifiedDiffToFiles('just some plain text, not a diff at all');
    expect(result.ok).toBe(false);
  });

  it('normalizes the converted path, not just the a/ b/ prefix', () => {
    const diff = '--- /dev/null\n+++ b/./src//new.ts\n@@ -0,0 +1,1 @@\n+export const x = 1;\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff?.files[0].path).toBe('src/new.ts');
  });

  it('does not launder a forbidden path through a ./ prefix', () => {
    const diff = '--- /dev/null\n+++ b/./.github/workflows/pwn.yml\n@@ -0,0 +1,1 @@\n+on: push\n';
    const result = convertUnifiedDiffToFiles(diff);
    expect(result.ok).toBe(true);
    expect(result.diff?.files[0].path).toBe('.github/workflows/pwn.yml');
  });
});
