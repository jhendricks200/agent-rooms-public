// Drizzle schema for Agent Rooms v0.
// Source of truth: docs/design/promote-provenance.md (Entities section) and
// docs/decisions/0003-polished-core-narrow-breadth.md.
//
// Design-doc ambiguities resolved here (see also the task report):
// - RemixNote is nested inside ProposalVersion in the design doc's TypeScript
//   interface, not listed as its own table. It is stored as a jsonb column on
//   proposal_versions rather than a separate table; its shape constraints
//   (empty or 1-6 bullets, length cap) are enforced by zod at the API layer, not by
//   the column type.
// - QAExchange has no id or timestamp fields in the design doc. A surrogate
//   id and createdAt are added here since a DB row needs a primary key and
//   an ordering column.
// - Room's token budget and cap fields are not named in the design doc; the
//   design doc only says pooled-key usage is "rate-capped per user and per
//   room, with a kill switch" (Safety mechanics, item 4). Field names below
//   are this task's best guess: tokenBudgetPerUser, tokenBudgetPerRoom,
//   tokenBudgetUsed, killSwitchEnabled.

import {
  pgTable,
  pgEnum,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// Proposal state machine. 'forked' is intentionally absent: forking is
// unbounded and derived from Fork records, not a state (design doc, Proposal
// entity note).
export const proposalStateEnum = pgEnum('proposal_state', [
  'open',
  'superseded',
  'adopted',
  'rejected',
]);

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  discordChannelRef: text('discord_channel_ref').notNull(),
  githubRepoRef: text('github_repo_ref').notNull(),
  maintainers: text('maintainers').array().notNull(), // contributorId[]
  adoptionAuthority: text('adoption_authority').notNull().default('maintainers'),
  createdBy: text('created_by').notNull(),
  license: text('license').notNull().default('MIT'),
  // Token budget / rate-cap / kill-switch fields for pooled hosted inference.
  // See Safety mechanics item 4 in the design doc; exact field shape is not
  // specified there, so this is this task's interpretation.
  tokenBudgetPerUser: integer('token_budget_per_user'),
  tokenBudgetPerRoom: integer('token_budget_per_room'),
  tokenBudgetUsed: integer('token_budget_used').notNull().default(0),
  killSwitchEnabled: boolean('kill_switch_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contributors = pgTable(
  'contributors',
  {
    id: text('id').primaryKey(), // global, cross-room
    displayName: text('display_name').notNull(),
    linkedDiscordId: text('linked_discord_id'),
    // linkedGithubId is the GitHub *login*: display metadata only, refreshed
    // at each sign-in, never an identity key (a login can be renamed and the
    // old one reclaimed by a different account).
    linkedGithubId: text('linked_github_id'),
    // linkedGithubUserId is GitHub's immutable numeric account id, as a
    // string. This is the identity key. Null for seeded demo contributors,
    // and null never matches a lookup.
    linkedGithubUserId: text('linked_github_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contributors_linked_github_id_idx').on(table.linkedGithubId),
    uniqueIndex('contributors_linked_github_user_id_idx').on(table.linkedGithubUserId),
  ],
);

export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(), // globally unique, permalinked
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id),
  authorContributorId: text('author_contributor_id')
    .notNull()
    .references(() => contributors.id),
  state: proposalStateEnum('state').notNull().default('open'),
  // global ids, may cross rooms
  parentProposalIds: text('parent_proposal_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Publication state of a ProposalVersion. A row is inserted 'pending' by
// promote before the GitHub branch/PR exist, and only becomes 'published'
// once the PR is real and the row carries its final prNumber/prUrl/
// headCommit/baseSha/contentHash. Nothing may fork, adopt, or display a
// pending row: it is an in-flight write, not a fact.
export const proposalVersionStatusEnum = pgEnum('proposal_version_status', ['pending', 'published']);

// Immutable once published (enforced at the database level by the
// proposal_versions_freeze trigger, migration 0007). Every fork records the
// exact versionId it consumed (design doc, ProposalVersion entity note).
export const proposalVersions = pgTable('proposal_versions', {
  versionId: text('version_id').primaryKey(),
  proposalId: text('proposal_id')
    .notNull()
    .references(() => proposals.id),
  intentSummary: text('intent_summary').notNull(),
  diffRef: text('diff_ref').notNull(),
  // baseRef: the branch name promote based the change on (this column was
  // previously misnamed after a git commit even though it always held a
  // branch name in practice, never a SHA).
  // baseSha: the real commit SHA baseRef resolved to at promote time
  // (via github.ts getRef), stored separately so the UI can show the
  // human-readable ref and the resolved SHA as distinct facts.
  baseRef: text('base_ref').notNull(),
  baseSha: text('base_sha').notNull(),
  headCommit: text('head_commit').notNull(), // exact PR head SHA at promotion time
  contentHash: text('content_hash').notNull(), // sha256
  // Real GitHub PR opened by promote for this version, when the room has a
  // linked repo and GITHUB_APP creds are present. Null for stubbed/local
  // promotes (design doc leaves promote's GitHub wiring unspecified beyond
  // "grounded on git ... attached to ... GitHub"; see task report).
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  // RemixNote, stored inline (see file header note). Shape:
  // { bullets: string[]; generatedBy: 'agent-draft'; authorEdited: boolean; lengthCapped: true }
  remixNote: jsonb('remix_note').notNull(),
  status: proposalVersionStatusEnum('status').notNull().default('pending'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
});

// Derived, regenerable read cache: the real unified diff for a proposal
// version's `modify` entries.
//
// This is deliberately NOT a column on proposal_versions. The stored diffRef
// carries whole-file content because that is what promote applies; the patch
// is a pure function of two immutable facts (the file content at the pinned
// baseSha, and the diffRef itself), so it is a cache, not provenance. Keeping
// it in its own table means nothing here can be mistaken for a provenance
// record, and the proposal_versions_freeze trigger and every frozen column it
// guards are left exactly as they were. Deleting every row here changes
// nothing except how long the next page render takes.
//
// baseSha is stored alongside so a cache entry can be recognised as stale and
// recomputed rather than trusted blindly.
export const proposalVersionPatches = pgTable('proposal_version_patches', {
  versionId: text('version_id')
    .primaryKey()
    .references(() => proposalVersions.versionId),
  baseSha: text('base_sha').notNull(),
  // { [repoRelativePath]: unifiedPatchText }
  patches: jsonb('patches').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const forks = pgTable(
  'forks',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    proposalVersionId: text('proposal_version_id')
      .notNull()
      .references(() => proposalVersions.versionId),
    byContributorId: text('by_contributor_id')
      .notNull()
      .references(() => contributors.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One person forking one version once is one fact. The fork route's
  // select-then-insert idempotency check races under concurrent requests;
  // this makes the database the arbiter.
  (table) => [
    uniqueIndex('forks_version_contributor_idx').on(
      table.proposalId,
      table.proposalVersionId,
      table.byContributorId,
    ),
  ],
);

// An adoption attempt is recorded 'pending' and committed BEFORE the
// GitHub merge is issued, then finalized to 'merged' in a second
// transaction with the real merge SHA. This is what makes adoption
// crash-safe: a process that dies between the merge and the finalize
// leaves a pending attempt behind, and the next adopt request for that
// proposal asks GitHub whether the PR is already merged rather than
// merging twice (see api/adopt/route.ts).
export const adoptionStatusEnum = pgEnum('adoption_status', ['pending', 'merged']);

export const adoptions = pgTable(
  'adoptions',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    proposalVersionId: text('proposal_version_id')
      .notNull()
      .references(() => proposalVersions.versionId),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    adoptedByContributorId: text('adopted_by_contributor_id')
      .notNull()
      .references(() => contributors.id), // must be in room.maintainers
    expectedHeadCommit: text('expected_head_commit').notNull(),
    mergeResult: text('merge_result').notNull(),
    // Real merge commit SHA returned by GitHub's merge API, when the merge
    // actually happened (as opposed to being gracefully stubbed).
    mergeCommitSha: text('merge_commit_sha'),
    adoptionReceiptRef: text('adoption_receipt_ref').notNull(), // portable receipt
    status: adoptionStatusEnum('status').notNull().default('pending'),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // A proposal can be adopted at most once, ever. Without this, a race
  // between two concurrent adopt requests (or a retried request) could
  // record two Adoption rows for the same proposal even though only one
  // merge can be truthful.
  (table) => [uniqueIndex('adoptions_proposal_id_idx').on(table.proposalId)],
);

// Chat messages: the group stream's plain talk, interleaved with proposal
// cards on the timeline spine in the room UI. Not named in the design doc's
// Entities section (that section covers the promote/fork/adopt loop only);
// added here so the room's group chat is backed by real rows instead of
// static markup, per the v0 web UI task.
export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id),
  authorContributorId: text('author_contributor_id')
    .notNull()
    .references(() => contributors.id),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// AgentSession: one per (contributor, room), auto-created on first sidebar
// use. Backs the hosted-model sidebar agent (private builder's copilot),
// distinct from the room's public messages table above.
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    ownerContributorId: text('owner_contributor_id')
      .notNull()
      .references(() => contributors.id),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agent_sessions_owner_room_idx').on(table.ownerContributorId, table.roomId)],
);

export const agentMessageRoleEnum = pgEnum('agent_message_role', ['system', 'user', 'assistant']);

// Shadow ledger: tokensIn/tokensOut recorded per assistant message so usage
// is queryable per session, per room, and per contributor.
// servedProvider/offPolicy: provider attestation for assistant messages,
// read from OpenRouter's per-chunk `provider` field (see lib/model.ts).
// offPolicy is true when the serving provider fell outside
// PINNED_US_EU_PROVIDER_SLUGS despite the routing pin, which should not
// happen but is recorded rather than silently trusted.
export const agentMessages = pgTable('agent_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id),
  role: agentMessageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  servedProvider: text('served_provider'),
  offPolicy: boolean('off_policy').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentReservationStatusEnum = pgEnum('agent_reservation_status', [
  'pending',
  'committed',
  'released',
]);

// Reservation ledger for atomic token-budget admission control. A row is
// inserted, and rooms.tokenBudgetUsed incremented, inside one locked
// transaction BEFORE the model is called (see lib/budget.ts reserveUsage),
// sized by a conservative estimate. It is reconciled to actual usage after
// streaming completes, or released (and the room counter backed out) on
// failure or client abort. This replaces a sum-then-write check that let
// concurrent requests race past the same cap (TOCTOU).
export const agentUsageReservations = pgTable('agent_usage_reservations', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id),
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  estimatedTokens: integer('estimated_tokens').notNull(),
  actualTokens: integer('actual_tokens'),
  status: agentReservationStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

// QAExchange: see file header note on the added id/createdAt columns.
export const qaExchanges = pgTable(
  'qa_exchanges',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    question: text('question').notNull(),
    askedBy: text('asked_by').notNull(),
    answer: text('answer'),
    answeredBy: text('answered_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('qa_exchanges_id_idx').on(table.id)],
);

// One row per request to a rate-limited route, written by lib/rateLimit.ts.
//
// This is an operational log, not provenance: nothing reads it except the
// limiter's own windowed count, and deleting every row only resets the
// counters. contributorId deliberately carries no foreign key. The limiter
// runs before a route has checked that the contributor row exists, and a
// counter that can fail on a constraint would turn a rate limit into a 500.
//
// The table stays small without a sweeper: every check deletes that
// contributor's expired rows for that action first, and a refused request
// writes nothing, so at most `max` rows per contributor per action are ever
// left behind.
export const rateLimitEvents = pgTable(
  'rate_limit_events',
  {
    id: text('id').primaryKey(),
    contributorId: text('contributor_id').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rate_limit_events_lookup_idx').on(table.contributorId, table.action, table.createdAt),
  ],
);
