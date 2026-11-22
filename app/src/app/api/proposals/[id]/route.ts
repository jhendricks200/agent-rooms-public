import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposals, proposalVersions, forks, qaExchanges } from '@/db/schema';
import { brokenLineageLinks, buildLineageChain } from '@/lib/lineage';
import { getCurrentContributorId } from '@/lib/session';

// Full card payload: intent, remix note, preview/diff, author, lineage
// (design doc, "a beautiful proposal page showing intent, remix note,
// preview, diff, author, and lineage", ADR 0003). Fork count is derived
// from Fork records, never stored as a proposal field (design doc, Proposal
// entity note).
//
// Reads are authenticated: a proposal's full diff and remix note are not
// public. The development identity fallback in lib/session.ts still
// applies, so local verify scripts are unaffected. Only published versions
// are returned; a pending version is an in-flight promote, not a fact.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const readerContributorId = await getCurrentContributorId();
  if (!readerContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await params;

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);

  if (!proposal) {
    return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  }

  const versions = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, id), eq(proposalVersions.status, 'published')));

  const proposalForks = await db.select().from(forks).where(eq(forks.proposalId, id));

  const qa = await db.select().from(qaExchanges).where(eq(qaExchanges.proposalId, id));

  const lineage = await buildLineageChain(id);

  return NextResponse.json({
    proposal,
    versions,
    forkCount: proposalForks.length,
    qaExchanges: qa,
    lineage,
    brokenLineageLinks: brokenLineageLinks(lineage).map((n) => n.id),
  });
}
