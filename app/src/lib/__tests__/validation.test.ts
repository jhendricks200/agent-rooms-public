import { describe, it, expect } from 'vitest';
import {
  createProposalSchema,
  forkSchema,
  createMessageSchema,
  adoptSchema,
  rejectSchema,
} from '@/lib/validation';

// The acting contributor id is always derived server-side from the session
// (lib/session.ts), never from the request body. These schemas are
// .strict(), so a client that still sends an actor-id field gets a 400
// instead of the field being silently dropped.

describe('createProposalSchema rejects a client-supplied authorContributorId', () => {
  const valid = {
    roomId: 'room_1',
    intentSummary: 'do a thing',
    diffRef: 'diff://abc',
    baseRef: 'base',
    headCommit: 'head',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false },
  };

  it('accepts the body without an actor id', () => {
    expect(createProposalSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the body when authorContributorId is present', () => {
    const result = createProposalSchema.safeParse({ ...valid, authorContributorId: 'contributor_evil' });
    expect(result.success).toBe(false);
  });
});

describe('forkSchema rejects a client-supplied byContributorId', () => {
  const valid = { proposalId: 'proposal_1', proposalVersionId: 'version_1' };

  it('accepts the body without an actor id', () => {
    expect(forkSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the body when byContributorId is present', () => {
    const result = forkSchema.safeParse({ ...valid, byContributorId: 'contributor_evil' });
    expect(result.success).toBe(false);
  });
});

describe('createMessageSchema rejects a client-supplied authorContributorId', () => {
  const valid = { roomId: 'room_1', body: 'hello' };

  it('accepts the body without an actor id', () => {
    expect(createMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the body when authorContributorId is present', () => {
    const result = createMessageSchema.safeParse({ ...valid, authorContributorId: 'contributor_evil' });
    expect(result.success).toBe(false);
  });
});

describe('adoptSchema rejects a client-supplied adoptedByContributorId', () => {
  const valid = { proposalId: 'proposal_1', proposalVersionId: 'version_1', roomId: 'room_1' };

  it('accepts the body without an actor id', () => {
    expect(adoptSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the body when adoptedByContributorId is present', () => {
    const result = adoptSchema.safeParse({ ...valid, adoptedByContributorId: 'contributor_evil' });
    expect(result.success).toBe(false);
  });
});

describe('rejectSchema rejects a client-supplied rejectedByContributorId', () => {
  const valid = { proposalId: 'proposal_1', roomId: 'room_1' };

  it('accepts the body without an actor id', () => {
    expect(rejectSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects the body when rejectedByContributorId is present', () => {
    const result = rejectSchema.safeParse({ ...valid, rejectedByContributorId: 'contributor_evil' });
    expect(result.success).toBe(false);
  });
});
