import { createHash } from 'node:crypto';

export interface ContentHashInput {
  diffRef: string;
  baseRef: string;
  baseSha: string;
  headCommit: string;
  intentSummary: string;
}

/**
 * Stable sha256 contentHash for a ProposalVersion (design doc:
 * "contentHash: string; // sha256"). Deterministic: the same inputs always
 * produce the same hash, and any change to any field changes the hash.
 * Field order is fixed (not derived from object key order) so this is
 * stable across JS engines and object construction order.
 *
 * Each field is length-prefixed (`${field.length}:${field}`) before
 * concatenation rather than joined with a plain separator. A plain join
 * (e.g. space-separated) lets two different field splits collide on the
 * same canonical string, for example baseRef="ab" + baseSha="c" vs
 * baseRef="a" + baseSha="bc" both joining to "ab c" / "a bc" only differ
 * by where the separator falls, and an attacker who controls both fields
 * (e.g. intentSummary and a following field) can shift content across a
 * field boundary to forge a collision. Length-prefixing removes that
 * ambiguity: the prefix fixes exactly how many bytes belong to each field.
 */
export function computeContentHash(input: ContentHashInput): string {
  const canonical = [input.baseRef, input.baseSha, input.headCommit, input.diffRef, input.intentSummary]
    .map((field) => `${field.length}:${field}`)
    .join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
