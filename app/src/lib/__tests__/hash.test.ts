import { describe, it, expect } from 'vitest';
import { computeContentHash } from '@/lib/hash';

describe('computeContentHash', () => {
  const base = {
    diffRef: 'diff://abc123',
    baseRef: 'main',
    baseSha: 'base-sha',
    headCommit: 'head-sha',
    intentSummary: 'add a feature',
  };

  it('is stable across repeated calls with identical input', () => {
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
  });

  it('produces a 64-character hex sha256 digest', () => {
    const hash = computeContentHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when headCommit changes', () => {
    const changed = computeContentHash({ ...base, headCommit: 'different-head-sha' });
    expect(changed).not.toBe(computeContentHash(base));
  });

  it('changes when the diff changes', () => {
    const changed = computeContentHash({ ...base, diffRef: 'diff://xyz789' });
    expect(changed).not.toBe(computeContentHash(base));
  });

  it('changes when the intent summary changes', () => {
    const changed = computeContentHash({ ...base, intentSummary: 'a different intent' });
    expect(changed).not.toBe(computeContentHash(base));
  });

  it('changes when baseRef changes', () => {
    const changed = computeContentHash({ ...base, baseRef: 'develop' });
    expect(changed).not.toBe(computeContentHash(base));
  });

  it('changes when baseSha changes', () => {
    const changed = computeContentHash({ ...base, baseSha: 'different-base-sha' });
    expect(changed).not.toBe(computeContentHash(base));
  });

  it('does not collide when content shifts across the baseRef/baseSha boundary (length-prefixed separation)', () => {
    const a = computeContentHash({ ...base, baseRef: 'ab', baseSha: 'c-rest' });
    const b = computeContentHash({ ...base, baseRef: 'a', baseSha: 'bc-rest' });
    expect(a).not.toBe(b);
  });

  it('does not collide when content shifts across the headCommit/diffRef boundary', () => {
    const a = computeContentHash({ ...base, headCommit: 'ab', diffRef: 'c-rest' });
    const b = computeContentHash({ ...base, headCommit: 'a', diffRef: 'bc-rest' });
    expect(a).not.toBe(b);
  });
});
