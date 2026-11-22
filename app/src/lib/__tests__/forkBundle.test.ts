import { describe, it, expect } from 'vitest';
import { buildForkBundle } from '@/lib/forkBundle';

describe('fork bundle', () => {
  it('contains exactly five parts: artifact, base commit, lineage chain, intent summary, remix note', () => {
    const bundle = buildForkBundle({
      diffRef: 'diff://abc',
      baseRef: 'main',
      baseSha: 'base-sha',
      lineage: [{ id: 'proposal_1', parentProposalIds: [] }],
      intentSummary: 'add a feature',
      remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    });

    // The base commit is one part expressed as two fields: the ref the work
    // was based on, and the exact commit that ref resolved to. Shipping
    // only the ref left the bundle without the commit it claims to pin.
    expect(Object.keys(bundle).sort()).toEqual(
      ['artifact', 'baseRef', 'baseSha', 'intentSummary', 'lineageChain', 'remixNote'].sort(),
    );
    expect(Object.keys(bundle)).toHaveLength(6);

    expect(bundle.artifact).toBe('diff://abc');
    expect(bundle.baseRef).toBe('main');
    expect(bundle.baseSha).toBe('base-sha');
    expect(bundle.lineageChain).toEqual([{ id: 'proposal_1', parentProposalIds: [] }]);
    expect(bundle.intentSummary).toBe('add a feature');
    expect(bundle.remixNote).toEqual({
      bullets: [],
      generatedBy: 'agent-draft',
      authorEdited: false,
      lengthCapped: true,
    });
  });
});
