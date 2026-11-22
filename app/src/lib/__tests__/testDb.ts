// Shared real-Postgres fixtures for the route-level integration tests in
// this directory (adopt, proposals, rooms). These tests hit the actual
// local database (DATABASE_URL from .env, loaded by vitest.setup.ts) so
// the DB transaction / SELECT ... FOR UPDATE behavior in adopt is
// genuinely exercised, mocking only 'octokit' and '@/lib/session'. All ids
// are randomly generated per test and cleaned up afterward.
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  rooms,
  contributors,
  proposals,
  proposalVersions,
  adoptions,
  forks,
  agentSessions,
  agentMessages,
  agentUsageReservations,
  rateLimitEvents,
} from '@/db/schema';
import { generateId } from '@/lib/ids';

export async function makeContributor(
  displayName = 'Test Contributor',
  opts: { linkedGithubId?: string | null; linkedGithubUserId?: string | null } = {},
) {
  const id = generateId('contributor_test');
  await db.insert(contributors).values({
    id,
    displayName,
    linkedGithubId: opts.linkedGithubId ?? null,
    linkedGithubUserId: opts.linkedGithubUserId ?? null,
  });
  return id;
}

export async function makeRoom(opts: {
  maintainers: string[];
  githubRepoRef?: string;
  tokenBudgetPerUser?: number | null;
  tokenBudgetPerRoom?: number | null;
  tokenBudgetUsed?: number;
  killSwitchEnabled?: boolean;
}) {
  const id = generateId('room_test');
  await db.insert(rooms).values({
    id,
    name: 'Test Room',
    discordChannelRef: 'discord:test',
    githubRepoRef: opts.githubRepoRef ?? 'test-owner/test-repo',
    maintainers: opts.maintainers,
    adoptionAuthority: 'maintainers',
    createdBy: opts.maintainers[0],
    license: 'MIT',
    tokenBudgetPerUser: opts.tokenBudgetPerUser ?? null,
    tokenBudgetPerRoom: opts.tokenBudgetPerRoom ?? null,
    tokenBudgetUsed: opts.tokenBudgetUsed ?? 0,
    killSwitchEnabled: opts.killSwitchEnabled ?? false,
  });
  return id;
}

export async function makeAgentSession(opts: { ownerContributorId: string; roomId: string }) {
  const id = generateId('agent_session_test');
  await db.insert(agentSessions).values({ id, ownerContributorId: opts.ownerContributorId, roomId: opts.roomId });
  return id;
}

export async function makeProposal(opts: {
  roomId: string;
  authorContributorId: string;
  state?: 'open' | 'superseded' | 'adopted' | 'rejected';
  parentProposalIds?: string[];
}) {
  const id = generateId('proposal_test');
  await db.insert(proposals).values({
    id,
    roomId: opts.roomId,
    authorContributorId: opts.authorContributorId,
    state: opts.state ?? 'open',
    parentProposalIds: opts.parentProposalIds ?? [],
  });
  return id;
}

export async function makeVersion(opts: {
  proposalId: string;
  prNumber?: number | null;
  headCommit?: string;
  publishedAt?: Date;
  status?: 'pending' | 'published';
}) {
  const versionId = generateId('version_test');
  await db.insert(proposalVersions).values({
    versionId,
    proposalId: opts.proposalId,
    intentSummary: 'test intent',
    diffRef: JSON.stringify({ files: [{ path: 'src/x.ts', content: 'x', changeType: 'add' }] }),
    baseRef: 'main',
    baseSha: 'basesha0000000000000000000000000000000',
    headCommit: opts.headCommit ?? 'headsha0000000000000000000000000000000',
    contentHash: 'a'.repeat(64),
    prNumber: opts.prNumber === undefined ? 7 : opts.prNumber,
    prUrl: opts.prNumber === undefined || opts.prNumber !== null ? 'https://github.com/test-owner/test-repo/pull/7' : null,
    status: opts.status ?? 'published',
    remixNote: { bullets: [], generatedBy: 'agent-draft', authorEdited: false, lengthCapped: true },
    ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
  });
  return versionId;
}

export async function makeReservation(opts: {
  sessionId: string;
  roomId: string;
  contributorId: string;
  estimatedTokens: number;
  status?: 'pending' | 'committed' | 'released';
  createdAt?: Date;
}) {
  const id = generateId('agent_reservation_test');
  await db.insert(agentUsageReservations).values({
    id,
    sessionId: opts.sessionId,
    roomId: opts.roomId,
    contributorId: opts.contributorId,
    estimatedTokens: opts.estimatedTokens,
    status: opts.status ?? 'pending',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  return id;
}

export async function makeFork(opts: { proposalId: string; proposalVersionId: string; byContributorId: string }) {
  const id = generateId('fork_test');
  await db.insert(forks).values({
    id,
    proposalId: opts.proposalId,
    proposalVersionId: opts.proposalVersionId,
    byContributorId: opts.byContributorId,
  });
  return id;
}

export async function cleanup(ids: {
  roomIds?: string[];
  contributorIds?: string[];
  proposalIds?: string[];
  sessionIds?: string[];
}) {
  // Published proposal_versions are frozen by the proposal_versions_freeze
  // trigger (migration 0007). Test teardown uses the trigger's explicit,
  // session-scoped escape; no application code ever sets it.
  for (const proposalId of ids.proposalIds ?? []) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL "agent_rooms.allow_provenance_mutation" = 'on'`);
      await tx.delete(forks).where(eq(forks.proposalId, proposalId));
      await tx.delete(adoptions).where(eq(adoptions.proposalId, proposalId));
      await tx.delete(proposalVersions).where(eq(proposalVersions.proposalId, proposalId));
      await tx.delete(proposals).where(eq(proposals.id, proposalId));
    });
  }
  for (const sessionId of ids.sessionIds ?? []) {
    await db.delete(agentUsageReservations).where(eq(agentUsageReservations.sessionId, sessionId));
    await db.delete(agentMessages).where(eq(agentMessages.sessionId, sessionId));
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
  }
  for (const roomId of ids.roomIds ?? []) {
    // A room's agent sessions can be created implicitly by the agent/message
    // route even when a request is refused before any message is written
    // (kill switch, budget caps), so clean those up by roomId too rather
    // than requiring every caller to track sessionIds explicitly.
    const roomSessions = await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.roomId, roomId));
    for (const s of roomSessions) {
      await db.delete(agentUsageReservations).where(eq(agentUsageReservations.sessionId, s.id));
      await db.delete(agentMessages).where(eq(agentMessages.sessionId, s.id));
    }
    await db.delete(agentSessions).where(eq(agentSessions.roomId, roomId));
    await db.delete(agentUsageReservations).where(eq(agentUsageReservations.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
  }
  for (const contributorId of ids.contributorIds ?? []) {
    // The limiter logs one row per request to a write route (lib/rateLimit.ts).
    await db.delete(rateLimitEvents).where(eq(rateLimitEvents.contributorId, contributorId));
    await db.delete(contributors).where(eq(contributors.id, contributorId));
  }
}
