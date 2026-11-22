// RemixNote validation. Design doc constraints (promote-provenance.md):
// - bullets: "one to six, each independently removable"
// - "An empty note is a normal, first-class option, not a failure state."
// - "Remix notes carry a hard length cap with a short default draft"
//   (Safety mechanics item 3), no exact number is given in the design doc,
// so MAX_BULLET_LENGTH and MAX_BULLETS below are this task's chosen values,
// not a documented spec. Flagged as a design-doc ambiguity in the task report.
//
// A note is either empty (no additional context, a first-class choice) or
// has 1-6 bullets. A floor of 3 for any non-empty note made "one thin
// bullet" and "no note" indistinguishable in practice, which contradicted
// the empty-is-first-class principle above.
export const MIN_BULLETS = 1;
export const MAX_BULLETS = 6;
export const MAX_BULLET_LENGTH = 280;

export interface RemixNoteInput {
  bullets: string[];
  generatedBy: 'agent-draft';
  authorEdited: boolean;
}

export interface RemixNoteValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRemixNote(input: RemixNoteInput): RemixNoteValidationResult {
  const errors: string[] = [];

  if (input.generatedBy !== 'agent-draft') {
    errors.push("generatedBy must be 'agent-draft'");
  }

  const count = input.bullets.length;
  const isEmpty = count === 0;

  if (!isEmpty && (count < MIN_BULLETS || count > MAX_BULLETS)) {
    errors.push(`bullets must be empty or contain ${MIN_BULLETS}-${MAX_BULLETS} items, got ${count}`);
  }

  input.bullets.forEach((bullet, index) => {
    if (bullet.trim().length === 0) {
      errors.push(`bullet ${index} is blank`);
    }
    if (bullet.length > MAX_BULLET_LENGTH) {
      errors.push(`bullet ${index} exceeds ${MAX_BULLET_LENGTH} characters`);
    }
  });

  return { valid: errors.length === 0, errors };
}
