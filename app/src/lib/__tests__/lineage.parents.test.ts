import { describe, it, expect, afterEach } from 'vitest';
import { validateParents } from '@/lib/lineage';
import { makeContributor, makeRoom, makeProposal, cleanup } from './testDb';

describe('validateParents', () => {
  const proposalIds: string[] = [];
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  afterEach(async () => {
    await cleanup({ proposalIds: proposalIds.splice(0), roomIds: roomIds.splice(0), contributorIds: contributorIds.splice(0) });
  });

  it('returns ok with no missing/cycle ids when parentProposalIds is empty', async () => {
    const result = await validateParents('proposal_new', []);
    expect(result).toEqual({ ok: true, missingIds: [], cycleIds: [] });
  });

  it('reports missing ids for parents that do not exist', async () => {
    const result = await validateParents('proposal_new', ['proposal_does_not_exist_1', 'proposal_does_not_exist_2']);
    expect(result.ok).toBe(false);
    expect(result.missingIds.sort()).toEqual(['proposal_does_not_exist_1', 'proposal_does_not_exist_2'].sort());
  });

  it('allows a valid diamond-shaped DAG (two parents sharing a grandparent) with no cycle', async () => {
    const author = await makeContributor();
    contributorIds.push(author);
    const roomId = await makeRoom({ maintainers: [author] });
    roomIds.push(roomId);

    const grandparent = await makeProposal({ roomId, authorContributorId: author });
    proposalIds.push(grandparent);
    const parentA = await makeProposal({ roomId, authorContributorId: author, parentProposalIds: [grandparent] });
    proposalIds.push(parentA);
    const parentB = await makeProposal({ roomId, authorContributorId: author, parentProposalIds: [grandparent] });
    proposalIds.push(parentB);

    const result = await validateParents('proposal_new_child', [parentA, parentB]);
    expect(result).toEqual({ ok: true, missingIds: [], cycleIds: [] });
  });

  it('detects a cycle when a listed parent is transitively a descendant of the id being validated', async () => {
    const author = await makeContributor();
    contributorIds.push(author);
    const roomId = await makeRoom({ maintainers: [author] });
    roomIds.push(roomId);

    const p1 = await makeProposal({ roomId, authorContributorId: author });
    proposalIds.push(p1);
    const p2 = await makeProposal({ roomId, authorContributorId: author, parentProposalIds: [p1] });
    proposalIds.push(p2);

    // Pretend we are validating p1 itself with p2 as a requested parent:
    // p2's ancestry includes p1, so accepting p2 as p1's parent would
    // create a cycle (p1 -> p2 -> p1).
    const result = await validateParents(p1, [p2]);
    expect(result.ok).toBe(false);
    expect(result.cycleIds).toContain(p1);
  });
});
