import { describe, it, expect } from 'vitest';
import { canTransition, transition } from '@/lib/stateMachine';

describe('proposal state machine', () => {
  it('allows open -> adopted, superseded, rejected', () => {
    expect(canTransition('open', 'adopted')).toBe(true);
    expect(canTransition('open', 'superseded')).toBe(true);
    expect(canTransition('open', 'rejected')).toBe(true);
  });

  it('treats adopted, superseded, and rejected as terminal', () => {
    for (const state of ['adopted', 'superseded', 'rejected'] as const) {
      for (const target of ['open', 'adopted', 'superseded', 'rejected'] as const) {
        if (state === target) continue;
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it('never allows a transition into a "forked" state, because it does not exist', () => {
    // @ts-expect-error 'forked' is intentionally not a valid ProposalState
    expect(canTransition('open', 'forked')).toBe(false);
  });

  it('transition() returns the next state on a valid transition', () => {
    expect(transition('open', 'rejected')).toBe('rejected');
  });

  it('transition() throws on an invalid transition', () => {
    expect(() => transition('adopted', 'open')).toThrow(/Invalid proposal state transition/);
  });
});
