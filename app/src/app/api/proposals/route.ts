import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, proposals, proposalVersions } from '@/db/schema';
import { createProposalSchema } from '@/lib/validation';
import { generateId } from '@/lib/ids';
import { computeContentHash } from '@/lib/hash';
import { validateRemixNote } from '@/lib/remixNote';
import { scanForSecrets } from '@/lib/secretScan';
import { parseDiffRef, type ProposalDiff } from '@/lib/diff';
import { convertUnifiedDiffToFiles } from '@/lib/unifiedDiff';
import { buildLineageChain, validateParents } from '@/lib/lineage';
import {
  credsPresent,
  createBranchAndApplyDiff,
  openPullRequest,
  closePullRequest,
  deleteBranch,
  splitRepoRef,
  DiffApplyError,
  PathPolicyError,
} from '@/lib/github';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// Promote: always mints a NEW Proposal and its first ProposalVersion. A
// version is never appended to an existing proposal by this route; a remix
// of prior work is expressed through parentProposalIds, not by adding a
// version to someone else's proposal. Requires baseRef + headCommit,
// computes contentHash, runs the secret-scan across the diff and remix
// note, and enforces remix note constraints (design doc:
// promote-provenance.md, ProposalVersion + RemixNote + Safety mechanics
// sections).
//
// Publication state: the ProposalVersion row is inserted with
// status 'pending' whenever a real PR is going to be opened for it. It
// becomes 'published' only once the branch and PR actually exist and the
// row carries its final prNumber/prUrl/headCommit/baseSha/contentHash.
// Nothing may fork, adopt, or display a pending row: it is an in-flight
// write, not a fact. A promote into a room with no linked repo or no
// GitHub credentials never opens a PR, so its version is published
// immediately (that fallback path is unchanged).
//
// Version immutability invariant: once a ProposalVersion row is published,
// intentSummary/diffRef/baseRef/baseSha/headCommit/contentHash are never
// touched by any code path. The ONE permitted mutation is the
// pending-to-published finalization below, in this same POST lifecycle.
// This is enforced at the database level by the proposal_versions_freeze
// trigger (migration 0007), not by convention.
//
// Ordering (no orphan PRs): the Proposal and ProposalVersion rows are
// inserted first, pending, with prNumber/prUrl null. Only then is the
// branch created, the diff applied, and the PR opened. If any GitHub step
// fails after the branch or PR was partially created, the PR (if opened) is
// closed and the branch (if created, including a failure part-way through
// applying the diff) is deleted, and the just-inserted DB rows are rolled
// back too, so a failed promote never leaves a dangling PR, a dangling
// proposal/* branch, or a proposal that claims a PR exists when it does not.
//
// diffRef accepts either the structured JSON {files:[...]} format or a
// fenced unified diff (the sidebar agent frequently emits the latter even
// though its system prompt asks for structured JSON); a unified diff is
// converted to structured files server-side via lib/unifiedDiff.ts so a
// sidebar-drafted promote still engages the real PR path rather than
// silently falling back to the no-PR stub.
export async function POST(request: NextRequest) {
  const authorContributorId = await getCurrentContributorId();
  if (!authorContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(authorContributorId, 'proposal.promote');
  if (limited) return limited;

  const body = await request.json();
  const parsed = createProposalSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  const remixNoteValidation = validateRemixNote(data.remixNote);
  if (!remixNoteValidation.valid) {
    return NextResponse.json(
      { error: 'invalid remix note', details: remixNoteValidation.errors },
      { status: 400 },
    );
  }

  const scanTargets = [data.diffRef, ...data.remixNote.bullets].join('\n');
  const scanResult = scanForSecrets(scanTargets);
  if (!scanResult.clean) {
    // Secret scanning runs before publish; a dirty scan blocks promotion
    // outright rather than publishing and redacting after the fact (design
    // doc, Safety mechanics item 1).
    return NextResponse.json(
      { error: 'secret scan failed', findings: scanResult.findings },
      { status: 422 },
    );
  }

  const proposalId = generateId('proposal');
  const versionId = generateId('version');

  // Parent integrity: every parentProposalIds entry must exist, and none
  // may create a cycle in the Proposal DAG. Cross-room parents are allowed.
  const parentValidation = await validateParents(proposalId, data.parentProposalIds);
  if (parentValidation.missingIds.length > 0) {
    return NextResponse.json(
      { error: 'unknown parentProposalIds', missingIds: parentValidation.missingIds },
      { status: 400 },
    );
  }
  if (parentValidation.cycleIds.length > 0) {
    return NextResponse.json(
      { error: 'parentProposalIds would create a cycle', cycleIds: parentValidation.cycleIds },
      { status: 400 },
    );
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, data.roomId)).limit(1);

  // Resolve the diff into structured files, if we're going to actually
  // apply it to a real repo. A room without a linked repo (or without
  // creds) never needs structured files: diffRef is stored as an opaque
  // pointer and no PR is opened, preserving the pre-existing fallback path.
  let resolvedFiles: ProposalDiff['files'] | null = null;
  if (room && credsPresent()) {
    const structured = parseDiffRef(data.diffRef);
    if (structured.ok) {
      resolvedFiles = structured.diff!.files;
    } else {
      const converted = convertUnifiedDiffToFiles(data.diffRef);
      if (converted.ok) {
        resolvedFiles = converted.diff!.files;
      } else {
        return NextResponse.json(
          { error: `diffRef could not be parsed as structured JSON or converted from a unified diff: ${converted.error}` },
          { status: 422 },
        );
      }
    }
  }

  // Whether this promote will do real GitHub wiring decides whether the
  // version starts pending (a PR is coming) or is published immediately
  // (no PR will ever exist for it).
  const willOpenPullRequest = Boolean(room && credsPresent() && resolvedFiles);

  // Step 1: insert the Proposal and its first ProposalVersion, with no PR
  // yet (see file header note on ordering).
  const placeholderContentHash = computeContentHash({
    diffRef: data.diffRef,
    baseRef: data.baseRef,
    baseSha: data.baseRef,
    headCommit: data.headCommit,
    intentSummary: data.intentSummary,
  });

  const [proposal] = await db
    .insert(proposals)
    .values({
      id: proposalId,
      roomId: data.roomId,
      authorContributorId,
      state: 'open',
      parentProposalIds: data.parentProposalIds,
    })
    .returning();

  let [version] = await db
    .insert(proposalVersions)
    .values({
      versionId,
      proposalId,
      intentSummary: data.intentSummary,
      diffRef: data.diffRef,
      baseRef: data.baseRef,
      baseSha: data.baseRef,
      headCommit: data.headCommit,
      contentHash: placeholderContentHash,
      prNumber: null,
      prUrl: null,
      status: willOpenPullRequest ? 'pending' : 'published',
      remixNote: {
        bullets: data.remixNote.bullets,
        generatedBy: data.remixNote.generatedBy,
        authorEdited: data.remixNote.authorEdited,
        lengthCapped: true,
      },
    })
    .returning();

  // Step 2: real PR wiring, only when the room has a linked repo, creds
  // are present, and the diff resolved to structured files above.
  if (willOpenPullRequest && room && resolvedFiles) {
    const { owner, repo } = splitRepoRef(room.githubRepoRef);
    const branch = `proposal/${proposalId}`;
    let branchCreated = false;
    let prNumberOpened: number | null = null;

    try {
      // The apply step resolves the base ref itself and reports the SHA it
      // actually committed on top of. That returned value is authoritative:
      // resolving the ref separately beforehand let the stored baseSha
      // disagree with the commit's real parent if the branch advanced in
      // between.
      const applyResult = await createBranchAndApplyDiff(
        owner,
        repo,
        branch,
        data.baseRef,
        resolvedFiles,
        data.intentSummary,
        { onRefCreated: () => { branchCreated = true; } },
      );
      const baseSha = applyResult.baseSha;
      const headCommit = applyResult.commitSha;

      const lineage = await buildLineageChain(proposalId).catch(() => []);
      const lineageText =
        data.parentProposalIds.length > 0
          ? `\n\nLineage: ${data.parentProposalIds.join(' -> ')}`
          : lineage.length > 0
            ? `\n\nLineage: ${lineage.map((n) => n.id).join(' -> ')}`
            : '';

      const contentHash = computeContentHash({
        diffRef: data.diffRef,
        baseRef: data.baseRef,
        baseSha,
        headCommit,
        intentSummary: data.intentSummary,
      });

      const bodyLines = [
        data.remixNote.bullets.length > 0
          ? `Remix note:\n${data.remixNote.bullets.map((b) => `- ${b}`).join('\n')}`
          : 'Remix note: (empty)',
        lineageText.trim(),
        `Content hash: ${contentHash}`,
        `Proposal: ${APP_BASE_URL}/proposal/${proposalId}`,
      ].filter(Boolean);

      const pr = await openPullRequest(
        owner,
        repo,
        branch,
        data.baseRef,
        data.intentSummary,
        bodyLines.join('\n\n'),
      );
      prNumberOpened = pr.number;

      // The one permitted mutation of a ProposalVersion: the
      // pending-to-published finalization, within this same request,
      // replacing the placeholder headCommit/contentHash with the real
      // values and filling in prNumber/prUrl/baseSha.
      [version] = await db
        .update(proposalVersions)
        .set({
          baseSha,
          headCommit,
          contentHash,
          prNumber: pr.number,
          prUrl: pr.url,
          status: 'published',
        })
        .where(eq(proposalVersions.versionId, versionId))
        .returning();
    } catch (error) {
      // GitHub failure after partial creation: close the PR if opened,
      // delete the branch if created, and roll back the DB rows inserted
      // in step 1 so a failed promote leaves nothing behind (no orphan
      // PRs, no proposal that claims a PR exists when it does not).
      if (prNumberOpened != null) {
        await closePullRequest(owner, repo, prNumberOpened).catch(() => {});
      }
      if (branchCreated) {
        await deleteBranch(owner, repo, branch).catch(() => {});
      }
      await db.delete(proposalVersions).where(eq(proposalVersions.versionId, versionId));
      await db.delete(proposals).where(eq(proposals.id, proposalId));

      if (error instanceof DiffApplyError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      if (error instanceof PathPolicyError) {
        return NextResponse.json(
          { error: error.message, rejectedPaths: error.rejectedPaths },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { error: 'failed to open pull request for this promote', detail: (error as Error).message },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ proposal, version }, { status: 201 });
}
