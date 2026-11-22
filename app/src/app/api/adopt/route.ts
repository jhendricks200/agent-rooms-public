import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, proposals, proposalVersions, adoptions } from '@/db/schema';
import { adoptSchema } from '@/lib/validation';
import { generateId } from '@/lib/ids';
import { mergePullRequest, getPullRequest, credsPresent, splitRepoRef, type MergeResult } from '@/lib/github';
import { canTransition, transition } from '@/lib/stateMachine';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

// Adopt: a maintainer merges a proposal's PR into the room's canonical
// build. owner/repo/pullNumber/expectedHeadCommit are never taken from the
// client: they come from the room's githubRepoRef and the pinned
// ProposalVersion's stored prNumber/headCommit (set by promote), so the
// room can never merge a PR or a head SHA different from what was actually
// promoted, hashed, and credited (design doc, "Adoption integrity").
// expectedHeadCommit is passed to GitHub's merge API as `sha`, so the merge
// fails if the PR head has moved since promotion.
//
// Fail-closed: an Adoption row is only ever finalized when a real merge
// actually happened. A stubbed merge (creds absent) or a version with no
// PR never counts as success:
//   - version is not published, or has no PR at all -> 409, nothing recorded.
//   - GITHUB_APP creds are absent -> 503, nothing recorded (we cannot
//     truthfully claim anything happened without being able to ask GitHub).
//   - GitHub rejects the merge (head moved, etc) -> 409, attempt released.
//
// Durability. The merge is an HTTP round trip to a third party and the
// process can die at any point around it, so it never runs inside a
// database transaction and never holds a row lock across it:
//
//   tx1  lock the proposal row, re-verify state and exact version pinning,
//        record a PENDING Adoption attempt, commit. The unique index on
//        adoptions.proposalId means at most one attempt can exist.
//   ---  merge on GitHub, holding no locks and no open transaction.
//   tx2  lock the proposal again, finalize the Adoption with the real merge
//        SHA and transition the proposal to 'adopted'.
//
// Crash safety and idempotency. If the process dies between the merge and
// tx2, a pending attempt is left behind. A later adopt request finds it and
// does NOT merge again: it asks GitHub for that PR's current state and
// either finalizes the existing attempt (the merge already happened) or
// releases it (the merge never happened) so a fresh attempt can be made.
// Recovery only applies to an attempt older than
// ADOPTION_ATTEMPT_RECOVERY_MS; a younger pending attempt belongs to a
// request genuinely in flight right now, and a concurrent caller gets a
// 409 rather than stealing it.
export const ADOPTION_ATTEMPT_RECOVERY_MS = 60_000;

type AttemptClaim =
  | { kind: 'conflict'; status: number; error: string }
  | { kind: 'attempt'; adoptionId: string }
  | { kind: 'recover'; adoptionId: string };

export async function POST(request: NextRequest) {
  const adoptedByContributorId = await getCurrentContributorId();
  if (!adoptedByContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(adoptedByContributorId, 'proposal.decide');
  if (limited) return limited;

  const body = await request.json();
  const parsed = adoptSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  const [room] = await db.select().from(rooms).where(eq(rooms.id, data.roomId)).limit(1);
  if (!room) {
    return NextResponse.json({ error: 'room not found' }, { status: 404 });
  }

  if (!room.maintainers.includes(adoptedByContributorId)) {
    // Adoption authority: 'maintainers' only, checked against the
    // server-derived Contributor id, never a platform id or a client claim
    // (design doc, Room entity note).
    return NextResponse.json(
      { error: 'acting contributor is not a maintainer of this room' },
      { status: 403 },
    );
  }

  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, data.proposalId))
    .limit(1);
  if (!proposal || proposal.roomId !== data.roomId) {
    return NextResponse.json({ error: 'proposal not found in this room' }, { status: 404 });
  }

  // Version pinning: honor exactly the proposalVersionId the caller asked
  // for. Never silently substitute the latest version for a stale or
  // wrong id the client happened to send.
  const [version] = await db
    .select()
    .from(proposalVersions)
    .where(
      and(
        eq(proposalVersions.versionId, data.proposalVersionId),
        eq(proposalVersions.proposalId, data.proposalId),
      ),
    )
    .limit(1);
  if (!version) {
    return NextResponse.json({ error: 'proposal version not found' }, { status: 404 });
  }
  if (version.status !== 'published') {
    return NextResponse.json(
      { error: 'this proposal version is not published; nothing to adopt' },
      { status: 409 },
    );
  }

  const allVersions = await db
    .select({ versionId: proposalVersions.versionId, publishedAt: proposalVersions.publishedAt })
    .from(proposalVersions)
    .where(
      and(eq(proposalVersions.proposalId, data.proposalId), eq(proposalVersions.status, 'published')),
    );
  const latest = allVersions.reduce((a, b) => (a.publishedAt > b.publishedAt ? a : b));
  if (allVersions.length > 1 && latest.versionId !== version.versionId) {
    return NextResponse.json(
      { error: 'requested proposalVersionId is not the latest published version of this proposal' },
      { status: 409 },
    );
  }

  if (!canTransition(proposal.state, 'adopted')) {
    return NextResponse.json(
      { error: `invalid proposal state transition: ${proposal.state} -> adopted` },
      { status: 409 },
    );
  }

  if (version.prNumber == null) {
    // No PR was ever opened for this version; there is nothing to merge.
    // This is never treated as a successful adoption.
    return NextResponse.json(
      { error: 'this proposal version has no associated pull request; nothing to adopt' },
      { status: 409 },
    );
  }

  if (!credsPresent()) {
    // We cannot verify anything without asking GitHub. Fail closed rather
    // than record a stubbed "success".
    return NextResponse.json(
      { error: 'GITHUB_APP credentials absent; cannot verify or perform the merge' },
      { status: 503 },
    );
  }

  const { owner, repo } = splitRepoRef(room.githubRepoRef);
  const pullNumber = version.prNumber;

  // --- Transaction one: claim the attempt. -------------------------------
  const claim: AttemptClaim = await db.transaction(async (tx) => {
    const [lockedProposal] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, data.proposalId))
      .for('update');

    if (!lockedProposal || !canTransition(lockedProposal.state, 'adopted')) {
      return {
        kind: 'conflict' as const,
        status: 409,
        error: `invalid proposal state transition: ${lockedProposal?.state ?? proposal.state} -> adopted`,
      };
    }

    const [existing] = await tx
      .select()
      .from(adoptions)
      .where(eq(adoptions.proposalId, data.proposalId))
      .limit(1);

    if (existing) {
      if (existing.status === 'merged') {
        return { kind: 'conflict' as const, status: 409, error: 'this proposal has already been adopted' };
      }
      if (Date.now() - existing.adoptedAt.getTime() < ADOPTION_ATTEMPT_RECOVERY_MS) {
        return {
          kind: 'conflict' as const,
          status: 409,
          error: 'an adoption attempt for this proposal is already in flight',
        };
      }
      return { kind: 'recover' as const, adoptionId: existing.id };
    }

    const adoptionId = generateId('adoption');
    await tx.insert(adoptions).values({
      id: adoptionId,
      proposalId: data.proposalId,
      proposalVersionId: version.versionId,
      roomId: data.roomId,
      adoptedByContributorId,
      expectedHeadCommit: version.headCommit,
      mergeResult: 'attempt recorded; merge not yet issued',
      mergeCommitSha: null,
      // portable receipt id; the receipt document itself is out of scope
      adoptionReceiptRef: adoptionId,
      status: 'pending',
    });

    return { kind: 'attempt' as const, adoptionId };
  });

  if (claim.kind === 'conflict') {
    return NextResponse.json({ error: claim.error }, { status: claim.status });
  }

  // --- Outside any transaction: talk to GitHub. --------------------------
  let mergeResult: MergeResult;

  if (claim.kind === 'recover') {
    // Do not merge again. Ask GitHub what actually happened to this PR.
    let pr: Awaited<ReturnType<typeof getPullRequest>>;
    try {
      pr = await getPullRequest(owner, repo, pullNumber);
    } catch (error) {
      return NextResponse.json(
        {
          error: 'could not read the pull request state to recover an unfinished adoption attempt',
          detail: (error as Error).message,
        },
        { status: 502 },
      );
    }

    if (!pr.merged) {
      // The merge never happened. Release the stale attempt so a later
      // request can start cleanly, and report the conflict.
      await releaseAttempt(claim.adoptionId);
      return NextResponse.json(
        { error: 'released a stale adoption attempt whose merge never completed; retry the adoption' },
        { status: 409 },
      );
    }

    mergeResult = {
      merged: true,
      stubbed: false,
      sha: pr.mergeCommitSha ?? undefined,
      message: 'merge recovered from GitHub: this pull request was already merged',
    };
  } else {
    try {
      mergeResult = await mergePullRequest({
        owner,
        repo,
        pullNumber,
        expectedHeadCommit: version.headCommit,
      });
    } catch (error) {
      await releaseAttempt(claim.adoptionId);
      return NextResponse.json(
        { error: 'merge call failed', detail: (error as Error).message },
        { status: 502 },
      );
    }

    if (!mergeResult.merged) {
      // Head moved since promotion, or GitHub otherwise rejected the merge.
      // No Adoption row survives, no state transition.
      await releaseAttempt(claim.adoptionId);
      return NextResponse.json({ error: 'merge rejected', mergeResult }, { status: 409 });
    }
  }

  // --- Transaction two: finalize. ----------------------------------------
  const finalized = await db.transaction(async (tx) => {
    const [lockedProposal] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, data.proposalId))
      .for('update');

    // The merge is a fact on GitHub by this point, so the proposal is
    // recorded as adopted even if its state drifted meanwhile: refusing
    // here would leave the repo merged and the room claiming otherwise.
    const nextState =
      lockedProposal && canTransition(lockedProposal.state, 'adopted')
        ? transition(lockedProposal.state, 'adopted')
        : ('adopted' as const);

    const [updatedProposal] = await tx
      .update(proposals)
      .set({ state: nextState })
      .where(eq(proposals.id, data.proposalId))
      .returning();

    const [adoption] = await tx
      .update(adoptions)
      .set({
        status: 'merged',
        mergeResult: mergeResult.message,
        mergeCommitSha: mergeResult.sha ?? null,
        adoptedAt: new Date(),
      })
      .where(eq(adoptions.id, claim.adoptionId))
      .returning();

    return { adoption, proposal: updatedProposal };
  });

  return NextResponse.json(
    { adoption: finalized.adoption, proposal: finalized.proposal, mergeResult },
    { status: 201 },
  );
}

// Releasing an attempt deletes the pending row outright rather than marking
// it, so the unique index on adoptions.proposalId frees up and the proposal
// can be adopted later. Only ever called for a merge that provably did not
// happen.
async function releaseAttempt(adoptionId: string): Promise<void> {
  await db.delete(adoptions).where(and(eq(adoptions.id, adoptionId), eq(adoptions.status, 'pending')));
}
