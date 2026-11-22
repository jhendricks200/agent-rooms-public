import type { LineageNode } from './lineage';

// The fork bundle is exactly five parts, no more (design doc: "The payload
// injected into a remixer's workspace is exactly five parts: the artifact
// (diff or files), the base commit, the lineage chain, the intent summary,
// and the remix note. Nothing else, ever.").
// "The base commit" is both parts: the human-readable ref the work was
// based on, and the exact commit SHA that ref resolved to at promote time.
// Shipping baseRef alone left the remixer without the commit the bundle
// claims to pin, since a branch name moves.
export interface ForkBundle {
  artifact: string; // diffRef: the diff or files reference
  baseRef: string;
  baseSha: string;
  lineageChain: LineageNode[];
  intentSummary: string;
  remixNote: unknown;
}

export interface ForkBundleInput {
  diffRef: string;
  baseRef: string;
  baseSha: string;
  lineage: LineageNode[];
  intentSummary: string;
  remixNote: unknown;
}

export function buildForkBundle(input: ForkBundleInput): ForkBundle {
  return {
    artifact: input.diffRef,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    lineageChain: input.lineage,
    intentSummary: input.intentSummary,
    remixNote: input.remixNote,
  };
}
