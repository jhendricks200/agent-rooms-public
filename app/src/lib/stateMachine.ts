// Proposal state machine. The design doc fixes the state set ('open',
// 'superseded', 'adopted', 'rejected', no 'forked': forking is unbounded
// and tracked via Fork records instead) but does not spell out the
// transition graph. The transitions below are this task's interpretation:
// open is the only non-terminal state, and every other state is terminal.
// Flagged as a design-doc ambiguity in the task report.

export type ProposalState = 'open' | 'superseded' | 'adopted' | 'rejected';

const TRANSITIONS: Record<ProposalState, ProposalState[]> = {
  open: ['superseded', 'adopted', 'rejected'],
  superseded: [],
  adopted: [],
  rejected: [],
};

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: ProposalState, to: ProposalState): ProposalState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid proposal state transition: ${from} -> ${to}`);
  }
  return to;
}
