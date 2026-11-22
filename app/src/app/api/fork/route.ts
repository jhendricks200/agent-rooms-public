import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposals, proposalVersions, forks } from '@/db/schema';
import { forkSchema } from '@/lib/validation';
import { generateId } from '@/lib/ids';
import { buildLineageChain, resolveLineageDetail } from '@/lib/lineage';
import { buildForkBundle } from '@/lib/forkBundle';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

// Fork: records the Fork event and returns the five-part bundle payload.
// Nothing is written to the forker's machine here. Materializing the branch
// and worktree on disk is a client/CLI-side concern per the design doc's
// "Mechanically, fork creates a new branch and a new git worktree" note, out
// of scope for this API route; the UI copy must not claim otherwise. Never
// continues the original agent session and never transfers hidden state
// (design doc, Fork entity note).
//
// Idempotent per (contributor, proposal version): a repeat fork returns the
// fork already on record with 200 instead of writing a second row. Two rows
// for one person forking one thing once are not two facts, and the forks
// list rendered them as peers.
export async function POST(request: NextRequest) {
  const byContributorId = await getCurrentContributorId();
  if (!byContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(byContributorId, 'fork.create');
  if (limited) return limited;

  const body = await request.json();
  const parsed = forkSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { proposalId, proposalVersionId } = parsed.data;

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) {
    return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  }

  const [version] = await db
    .select()
    .from(proposalVersions)
    .where(
      and(
        eq(proposalVersions.versionId, proposalVersionId),
        eq(proposalVersions.proposalId, proposalId),
      ),
    )
    .limit(1);

  if (!version) {
    return NextResponse.json({ error: 'proposal version not found' }, { status: 404 });
  }

  // A pending version is an in-flight promote whose branch and PR may not
  // exist yet and whose baseSha/headCommit/contentHash are still
  // placeholders. Forking one would hand a remixer a bundle pinned to
  // nothing.
  if (version.status !== 'published') {
    return NextResponse.json(
      { error: 'proposal version is not published yet and cannot be forked' },
      { status: 409 },
    );
  }

  const lineage = await buildLineageChain(proposalId);

  const bundle = buildForkBundle({
    diffRef: version.diffRef,
    baseRef: version.baseRef,
    baseSha: version.baseSha,
    lineage,
    intentSummary: version.intentSummary,
    remixNote: version.remixNote,
  });

  // Names and titles for the credit chain. The bundle's own lineageChain is
  // left exactly as it is: the payload is five parts and no more, so this
  // travels beside the bundle as a presentation aid, not inside it.
  const chain = await resolveLineageDetail(lineage);

  const [existingFork] = await db
    .select()
    .from(forks)
    .where(
      and(
        eq(forks.proposalId, proposalId),
        eq(forks.proposalVersionId, proposalVersionId),
        eq(forks.byContributorId, byContributorId),
      ),
    )
    .limit(1);

  if (existingFork) {
    return NextResponse.json(
      { fork: existingFork, bundle, chain, alreadyForked: true },
      { status: 200 },
    );
  }

  // The select above is a fast path, not the arbiter: two concurrent
  // requests can both miss it. The unique index on (proposal, version,
  // contributor) decides, and a lost race reads back the winner's row so
  // the response stays idempotent either way.
  const forkId = generateId('fork');
  const [fork] = await db
    .insert(forks)
    .values({
      id: forkId,
      proposalId,
      proposalVersionId,
      byContributorId,
    })
    .onConflictDoNothing({
      target: [forks.proposalId, forks.proposalVersionId, forks.byContributorId],
    })
    .returning();

  if (!fork) {
    const [racedFork] = await db
      .select()
      .from(forks)
      .where(
        and(
          eq(forks.proposalId, proposalId),
          eq(forks.proposalVersionId, proposalVersionId),
          eq(forks.byContributorId, byContributorId),
        ),
      )
      .limit(1);
    return NextResponse.json(
      { fork: racedFork, bundle, chain, alreadyForked: true },
      { status: 200 },
    );
  }

  return NextResponse.json({ fork, bundle, chain, alreadyForked: false }, { status: 201 });
}
