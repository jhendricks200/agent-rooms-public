import { describe, it, expect } from 'vitest';
import { validateRemixNote, MAX_BULLET_LENGTH } from '@/lib/remixNote';

function note(bullets: string[]) {
  return { bullets, generatedBy: 'agent-draft' as const, authorEdited: false };
}

describe('remix note validation', () => {
  it('accepts an empty note as first-class, not a failure', () => {
    expect(validateRemixNote(note([])).valid).toBe(true);
  });

  it('accepts 1 to 6 bullets', () => {
    expect(validateRemixNote(note(['a'])).valid).toBe(true);
    expect(validateRemixNote(note(['a', 'b'])).valid).toBe(true);
    expect(validateRemixNote(note(['a', 'b', 'c'])).valid).toBe(true);
    expect(validateRemixNote(note(['a', 'b', 'c', 'd', 'e', 'f'])).valid).toBe(true);
  });

  it('rejects more than 6 bullets', () => {
    expect(validateRemixNote(note(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).valid).toBe(false);
  });

  it('rejects a bullet over the length cap', () => {
    const result = validateRemixNote(note(['a', 'b', 'x'.repeat(MAX_BULLET_LENGTH + 1)]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds'))).toBe(true);
  });

  it('rejects a blank bullet', () => {
    expect(validateRemixNote(note(['a', '  ', 'c'])).valid).toBe(false);
  });

  it('rejects a generatedBy value other than agent-draft', () => {
    const result = validateRemixNote({
      bullets: ['a', 'b', 'c'],
      // @ts-expect-error generatedBy must be the literal 'agent-draft'
      generatedBy: 'human',
      authorEdited: false,
    });
    expect(result.valid).toBe(false);
  });
});
