import { z } from 'zod';

// createdBy and maintainers are deliberately absent: room creation authority
// is derived server-side from the session (see api/rooms/route.ts), and the
// creator is the sole initial maintainer. .strict() so a client that still
// sends either field gets a 400 instead of it being silently ignored or,
// worse, used to plant an arbitrary maintainers roster.
export const createRoomSchema = z
  .object({
    name: z.string().min(1),
    discordChannelRef: z.string().min(1),
    githubRepoRef: z.string().min(1),
    license: z.string().min(1).default('MIT'),
    tokenBudgetPerUser: z.number().int().positive().optional(),
    tokenBudgetPerRoom: z.number().int().positive().optional(),
  })
  .strict();

export const remixNoteInputSchema = z.object({
  bullets: z.array(z.string()),
  generatedBy: z.literal('agent-draft'),
  authorEdited: z.boolean(),
});

// authorContributorId, byContributorId, adoptedByContributorId and
// rejectedByContributorId are deliberately absent from these schemas: the
// acting contributor is always derived server-side from the session (see
// lib/session.ts), never taken from the request body. .strict() makes a
// client that still sends one of those fields fail validation instead of
// having it silently ignored, so an impersonation attempt is visible as a
// 400, not a 401 that could be misread as "field just wasn't used".
export const createProposalSchema = z
  .object({
    roomId: z.string().min(1),
    parentProposalIds: z.array(z.string()).default([]),
    intentSummary: z.string().min(1),
    diffRef: z.string().min(1),
    baseRef: z.string().min(1),
    headCommit: z.string().min(1),
    remixNote: remixNoteInputSchema,
  })
  .strict();

export const forkSchema = z
  .object({
    proposalId: z.string().min(1),
    proposalVersionId: z.string().min(1),
  })
  .strict();

export const createMessageSchema = z
  .object({
    roomId: z.string().min(1),
    body: z.string().min(1).max(4000),
  })
  .strict();

export const adoptSchema = z
  .object({
    proposalId: z.string().min(1),
    proposalVersionId: z.string().min(1),
    roomId: z.string().min(1),
  })
  .strict();

// Maintainer roster changes. roomId comes from the route path and the
// acting contributor from the session, so neither appears here.
export const maintainerChangeSchema = z
  .object({
    contributorId: z.string().min(1),
    action: z.enum(['add', 'remove']),
  })
  .strict();

// Room agent kill switch flips. The desired state is stated explicitly
// (`enabled`) rather than as a toggle, so a repeated or retried request
// lands on the same state instead of flipping the switch back: this is an
// emergency control and must be safe to hit twice.
// roomId is present so the body cannot be replayed against a different
// room than the caller meant; the route refuses a body whose roomId
// disagrees with the path. No actor id: the acting contributor comes only
// from the session (lib/session.ts), and .strict() turns an attempt to
// supply one into a visible 400 rather than a silently ignored field.
export const killSwitchSchema = z
  .object({
    roomId: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export const rejectSchema = z
  .object({
    proposalId: z.string().min(1),
    roomId: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();
