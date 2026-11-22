import { NextRequest, NextResponse } from 'next/server';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, proposals, proposalVersions } from '@/db/schema';
import { rejectSchema } from '@/lib/validation';
import { canTransition, transition } from '@/lib/stateMachine';
import { closePullRequest, splitRepoRef } from '@/lib/github';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

// Reject: a maintainer declines a proposal. Design doc: "Rejected proposals
// close the PR without merge." The PR is closed (not merged) when this
// version has one; the proposal transitions to 'rejected' regardless of
// whether a PR exists, so rooms without a real repo still work.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejectedByContributorId = await getCurrentContributorId();
  if (!rejectedByContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(rejectedByContributorId, 'proposal.decide');
  if (limited) return limited;

  const { id } = await params;
  const body = await request.json();
  const parsed = rejectSchema.safeParse({ ...body, proposalId: id });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  const [room] = await db.select().from(rooms).where(eq(rooms.id, data.roomId)).limit(1);
  if (!room) {
    return NextResponse.json({ error: 'room not found' }, { status: 404 });
  }

  if (!room.maintainers.includes(rejectedByContributorId)) {
    return NextResponse.json(
      { error: 'acting contributor is not a maintainer of this room' },
      { status: 403 },
    );
  }

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, data.proposalId)).limit(1);
  if (!proposal || proposal.roomId !== data.roomId) {
    return NextResponse.json({ error: 'proposal not found in this room' }, { status: 404 });
  }

  // stateMachine transition errors map to 409, never an uncaught 500.
  if (!canTransition(proposal.state, 'rejected')) {
    return NextResponse.json(
      { error: `invalid proposal state transition: ${proposal.state} -> rejected` },
      { status: 409 },
    );
  }

  const [version] = await db
    .select()
    .from(proposalVersions)
    .where(
      and(eq(proposalVersions.proposalId, data.proposalId), eq(proposalVersions.status, 'published')),
    )
    .orderBy(desc(proposalVersions.publishedAt))
    .limit(1);

  if (version?.prNumber != null) {
    const { owner, repo } = splitRepoRef(room.githubRepoRef);
    await closePullRequest(owner, repo, version.prNumber);
  }

  const nextState = transition(proposal.state, 'rejected');
  const [updatedProposal] = await db
    .update(proposals)
    .set({ state: nextState })
    .where(eq(proposals.id, data.proposalId))
    .returning();

  return NextResponse.json({ proposal: updatedProposal }, { status: 200 });
}
