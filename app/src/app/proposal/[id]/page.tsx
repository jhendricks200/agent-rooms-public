import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { proposals, proposalVersions, forks, qaExchanges, contributors, adoptions, rooms } from '@/db/schema';
import { getProposalPatches } from '@/lib/proposalPatch';
import { brokenLineageLinks, buildLineageChain, resolveLineageDetail } from '@/lib/lineage';
import { DiffView } from '@/components/DiffView';
import { ForkButton } from '@/components/ForkButton';
import { AdoptButton } from '@/components/AdoptButton';
import { avatarClass, initials, relativeTime, shortHash } from '@/lib/ui';
import { getCurrentContributorId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The linked room repo is private, so a proposal's diff, intent, and
  // resolved base content are not public either. An anonymous visitor is
  // sent to sign in, same as the room page.
  const currentContributorId = await getCurrentContributorId();
  if (!currentContributorId) {
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(`/proposal/${id}`)}`);
  }

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!proposal) notFound();

  // Only published versions exist as far as any reader is concerned.
  const versions = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, id), eq(proposalVersions.status, 'published')))
    .orderBy(proposalVersions.publishedAt);
  const latestVersion = versions[versions.length - 1];
  if (!latestVersion) notFound();

  const [room] = await db.select().from(rooms).where(eq(rooms.id, proposal.roomId)).limit(1);
  // The stored artifact is whole-file content; the diff is resolved against
  // the pinned baseSha and cached. See lib/proposalPatch.ts for why this is a
  // read-time computation rather than a promote-time one.
  const diffPatches = await getProposalPatches(latestVersion, room?.githubRepoRef);

  const [author] = await db.select().from(contributors).where(eq(contributors.id, proposal.authorContributorId)).limit(1);
  const proposalForks = await db.select().from(forks).where(eq(forks.proposalId, id));
  const qa = await db.select().from(qaExchanges).where(eq(qaExchanges.proposalId, id));
  const [adoption] = await db.select().from(adoptions).where(eq(adoptions.proposalId, id)).limit(1);

  const allContributors = await db.select().from(contributors);
  const contributorById = new Map(allContributors.map((c) => [c.id, c]));
  const nameFor = (idOrHandle: string) => contributorById.get(idOrHandle)?.displayName ?? idOrHandle;

  const lineageNodes = await buildLineageChain(id);
  const brokenAncestors = brokenLineageLinks(lineageNodes).filter((n) => n.id !== id);
  // Same resolution the fork receipt renders, from the same function, so the
  // credit chain reads identically in both places.
  const lineageWithDetail = (await resolveLineageDetail(lineageNodes.filter((n) => n.id !== id && !n.missing)))
    .filter((n) => !n.missing);

  // This reader's own fork of the version on screen, if there is one. Forking
  // twice is not a second fact, so the control offers the fork already on
  // record rather than a duplicate.
  const myFork = currentContributorId
    ? proposalForks.find(
        (f) => f.byContributorId === currentContributorId && f.proposalVersionId === latestVersion.versionId,
      )
    : undefined;

  const remixNote = (latestVersion.remixNote as { bullets?: string[] } | undefined)?.bullets ?? [];
  const authorName = author?.displayName ?? 'Unknown';

  // Whether to offer the adopt control at all. This mirrors the route's own
  // gate (POST /api/adopt is maintainer-only against the server-derived
  // session and 403s anyone else); it does not replace it. Offering a
  // control the server is going to refuse teaches a stranger that the
  // product is broken, so a non-maintainer simply never sees it.
  const isMaintainer = currentContributorId != null && room?.maintainers.includes(currentContributorId) === true;
  const canAdopt =
    isMaintainer && proposal.state === 'open' && latestVersion.prNumber != null && room != null && !adoption
      ? { prNumber: latestVersion.prNumber, repoRef: room.githubRepoRef }
      : null;

  // Everyone a merge records credit for: the ancestors this change was built
  // on, oldest first, then this proposal's own author. Same chain the page
  // renders above, so the confirmation cannot promise credit the record does
  // not carry.
  const creditNames = [
    ...[...lineageWithDetail].reverse().map((node) => node.authorName ?? 'Unknown'),
    authorName,
  ];

  const answeredQa = qa.filter((x) => x.answer);
  const stateLabel = proposal.state === 'open' ? 'open' : proposal.state;
  const stateChipClass = proposal.state === 'open' ? 'proposed' : proposal.state;

  return (
    <div className="proposal-page" data-state={proposal.state}>
      <div className="proposal-topbar">
        <Link href={`/room/${proposal.roomId}`} className="back-link">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M10 3 5 8l5 5" />
          </svg>
          Back to room
        </Link>
        <span className="crumb">
          {proposal.roomId} / proposals / {proposal.id}
        </span>
        <span className="spacer" />
        {latestVersion.prNumber != null && <span className="pr-tag">PR #{latestVersion.prNumber}</span>}
      </div>

      <div className="proposal-grid">
        {/* ---------------- the change ---------------- */}
        <main className="proposal-read">
          <section className="proposal-detail-head">
            {proposal.state === 'rejected' && (
              <div className="ribbon r-rejected">
                <span className="flare">
                  <span className="dot" />
                  Not adopted · pull request closed
                </span>
              </div>
            )}
            {proposal.state === 'superseded' && (
              <div className="ribbon r-super">
                <span className="flare">
                  <span className="dot" />
                  Superseded · a later proposal absorbed this
                </span>
              </div>
            )}

            <div className="head-row">
              <h1>{latestVersion.intentSummary}</h1>
              <span className={`state-chip ${stateChipClass}`}>{stateLabel}</span>
            </div>

            <div className="meta-row">
              <span className="who">
                <span className={`avatar ${avatarClass(proposal.authorContributorId)}`}>{initials(authorName)}</span>
                {authorName}
              </span>
              <span>{relativeTime(latestVersion.publishedAt)}</span>
              <span>
                base {latestVersion.baseRef} <span className="hash">{shortHash(latestVersion.baseSha)}</span>
              </span>
              <span className="forks">
                {proposalForks.length} {proposalForks.length === 1 ? 'fork' : 'forks'}
              </span>
            </div>

            {brokenAncestors.length > 0 && (
              <p className="lineage-broken" role="alert" style={{ marginTop: 14 }}>
                Broken lineage: {brokenAncestors.length} ancestor
                {brokenAncestors.length === 1 ? '' : 's'} referenced by this chain{' '}
                {brokenAncestors.length === 1 ? 'is' : 'are'} missing from the record (
                {brokenAncestors.map((n) => n.id).join(', ')}). This provenance chain is incomplete.
              </p>
            )}

            {lineageWithDetail.length > 0 && (
              <details className="chain-disclosure">
                <summary>
                  <span className="chev" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </span>
                  chain
                </summary>
                <div className="lineage">
                  <div className="lineage-title">Ancestors, oldest first</div>
                  {[...lineageWithDetail].reverse().map((node) => (
                    <div className="lineage-row" key={node.id}>
                      <span className={`l-dot ${node.isRemix ? 'remix' : 'origin'}`} />
                      <Link href={`/proposal/${node.id}`} className="txt">
                        <b>{node.authorName ?? 'Unknown'}</b> · {node.intentSummary ?? '(no published version)'}
                      </Link>
                      <span className="spacer" />
                      <span className="hash">{node.headCommit ? shortHash(node.headCommit) : '—'}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          {remixNote.length > 0 && (
            <section>
              <div className="sec-head">
                <h2>What changed from the parent</h2>
                <span className="spacer" />
                <span className="aside">written by {authorName}</span>
              </div>
              <div className="panel-note">
                <ul>
                  {remixNote.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section>
            <div className="sec-head">
              <h2>Diff</h2>
            </div>
            <DiffView
              diff={latestVersion.diffRef}
              patches={diffPatches.patches}
              unavailableReason={diffPatches.unavailableReason}
            />
          </section>

          <section>
            <div className="sec-head">
              <h2>Questions</h2>
              <span className="spacer" />
              {qa.length > 0 && <span className="aside">{answeredQa.length} answered</span>}
            </div>
            <div className="detail-section">
              {qa.length === 0 ? (
                <p className="qa-empty">No questions yet. Questions asked in the room are mirrored here once answered.</p>
              ) : (
                qa.map((exchange) => (
                  <div className="qa-item" key={exchange.id}>
                    <span className={`avatar ${avatarClass(exchange.askedBy)}`}>{initials(nameFor(exchange.askedBy))}</span>
                    <div className="qa-main">
                      <p className="qa-q">
                        <b>{nameFor(exchange.askedBy)}</b> · {exchange.question}
                      </p>
                      {exchange.answer && <p className="qa-a">{exchange.answer}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>

        {/* ---------------- the decision ---------------- */}
        <aside className="proposal-side" aria-label="Decide on this proposal">
          <div className="decide">
            <div className="detail-actions">
              {canAdopt && (
                <AdoptButton
                  roomId={proposal.roomId}
                  proposalId={proposal.id}
                  proposalVersionId={latestVersion.versionId}
                  prNumber={canAdopt.prNumber}
                  repoRef={canAdopt.repoRef}
                  baseRef={latestVersion.baseRef}
                  headCommit={latestVersion.headCommit}
                  creditNames={creditNames}
                />
              )}
              <ForkButton
                proposalId={proposal.id}
                proposalVersionId={latestVersion.versionId}
                signedIn={currentContributorId != null}
                intentSummary={latestVersion.intentSummary}
                authorName={authorName}
                baseRef={latestVersion.baseRef}
                baseSha={latestVersion.baseSha}
                alreadyForkedAt={myFork?.createdAt.toISOString() ?? null}
              />
              {/* No remix action exists: promote posts an empty
                  parentProposalIds, so a remix is a fork followed by a
                  promote. Disabled rather than a clickable-looking span. */}
              {/* No Remix button until remix-in-place exists: the real remix
                  path is fork, rebuild, promote, and the fork receipt says
                  so. A control that cannot act does not render. */}
              {latestVersion.prUrl && (
                <a className="mini-btn" href={latestVersion.prUrl} target="_blank" rel="noopener noreferrer">
                  {adoption ? 'Merged PR' : 'Open PR'}
                </a>
              )}
            </div>
            <p className="act-note">
              {adoption
                ? 'Merged into the build. The fork bundle still resolves against the head commit.'
                : proposal.state === 'rejected'
                  ? 'The pull request is closed and nothing merged. The head commit and the fork bundle still resolve.'
                  : myFork
                    ? 'You forked this version. The fork is on record and the bundle still resolves against the head commit.'
                    : 'Forking records a fork credited to you and hands you the bundle, pinned to the head commit below. Nothing is written to your machine.'}{' '}
              <span className="mono">{shortHash(latestVersion.headCommit)}</span>
            </p>

            <div className="rule" />

            <div className="side-head">
              <span className="h">Forks</span>
              <span className="spacer" />
              <span className="n">{proposalForks.length}</span>
            </div>
            {proposalForks.length === 0 ? (
              <p className="act-note" style={{ marginTop: 0 }}>
                No one has forked this yet.
              </p>
            ) : (
              <div className="forks">
                {proposalForks.map((fork) => (
                  <div className="fork-row" key={fork.id}>
                    <span className={`avatar ${avatarClass(fork.byContributorId)}`}>
                      {initials(nameFor(fork.byContributorId))}
                    </span>
                    <div className="f-main">
                      <div className="f-who">
                        {nameFor(fork.byContributorId)}
                        {fork.id === myFork?.id ? ' · you' : ''}
                      </div>
                      <div className="f-what">took the bundle</div>
                    </div>
                    <span className="f-when">{relativeTime(fork.createdAt.toISOString())}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="rule" />

            <details className="prov">
              <summary className="prov-toggle">
                <span className="t">Provenance</span>
                <span className="spacer" />
                <span className="tag">ledger</span>
                <span className="chev" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </span>
              </summary>
              <dl className="ledger">
                <div className="lrow">
                  <dt>base</dt>
                  <dd>
                    {latestVersion.baseRef} {shortHash(latestVersion.baseSha)}
                  </dd>
                </div>
                <div className="lrow">
                  <dt>head</dt>
                  <dd>{latestVersion.headCommit}</dd>
                </div>
                <div className="lrow">
                  <dt>content</dt>
                  <dd>{shortHash(latestVersion.contentHash, 24)}</dd>
                </div>
                <div className="lrow">
                  <dt>published</dt>
                  <dd>{new Date(latestVersion.publishedAt).toISOString()}</dd>
                </div>
                {latestVersion.prNumber != null && (
                  <div className="lrow">
                    <dt>pull req</dt>
                    <dd>#{latestVersion.prNumber}</dd>
                  </div>
                )}
                {adoption && (
                  <div className="lrow">
                    <dt>adopted</dt>
                    <dd>{new Date(adoption.adoptedAt).toISOString()}</dd>
                  </div>
                )}
                {adoption?.mergeCommitSha && (
                  <div className="lrow">
                    <dt>merge</dt>
                    <dd className="ok">{shortHash(adoption.mergeCommitSha)}</dd>
                  </div>
                )}
              </dl>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}
