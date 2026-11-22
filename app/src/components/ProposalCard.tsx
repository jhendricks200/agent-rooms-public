import Link from 'next/link';
import { ForkButton } from './ForkButton';
import { avatarClass, initials, relativeTime, shortHash } from '@/lib/ui';

export interface LineageEntry {
  contributorId: string;
  displayName: string;
  intentSummary: string;
  hash: string;
  role: 'origin' | 'remix' | 'final';
  // The proposal this row names, when it is a real proposal in the record.
  // Absent for the synthetic "Room" row that closes an adopted chain.
  proposalId?: string;
}

// Controls the comps draw but nothing in the codebase implements. They stay
// on the card so the composition is unchanged, but they are rendered
// genuinely disabled rather than as clickable-looking spans: there is no
// watch/subscribe model, no reopen path, and no remix action distinct from
// fork-then-promote anywhere in the app or the API.

export interface ProposalCardData {
  id: string;
  state: 'open' | 'superseded' | 'adopted' | 'rejected';
  variant: 'proposed' | 'fork-live' | 'adopted' | 'rejected' | 'superseded';
  intentSummary: string;
  remixNoteBullets: string[];
  authorId: string;
  authorName: string;
  createdAt: string;
  forkCount: number;
  qaCount: number;
  contentHash: string;
  forkingByName?: string; // present when variant === 'fork-live'
  lineage?: LineageEntry[]; // present when variant === 'adopted'
  rejectionNote?: string; // present when variant === 'rejected'
  prNumber?: number | null;
  prUrl?: string | null;
  mergeCommitSha?: string | null; // present when variant === 'adopted' and the merge really happened
  // The published version the Fork control acts on. Absent when the proposal
  // has no published version, in which case there is nothing forkable.
  proposalVersionId?: string | null;
  signedIn: boolean;
  /** ISO timestamp of this reader's own fork of that version, when one exists. */
  myForkAt?: string | null;
  baseRef?: string | null;
  baseSha?: string | null;
}

const stateChipLabel: Record<ProposalCardData['variant'], string> = {
  proposed: 'proposed',
  'fork-live': 'fork live',
  adopted: 'adopted',
  rejected: 'rejected',
  superseded: 'superseded',
};

const stateClassName: Record<ProposalCardData['variant'], string> = {
  proposed: 'proposed',
  'fork-live': 'forking',
  adopted: 'adopted',
  rejected: 'rejected',
  superseded: 'review',
};

const cardStateClass: Record<ProposalCardData['variant'], string> = {
  proposed: 'state-proposed',
  'fork-live': 'state-fork',
  adopted: 'state-adopted',
  rejected: 'state-rejected',
  superseded: 'state-review',
};

export function ProposalCard(data: ProposalCardData) {
  const isAdopted = data.variant === 'adopted';
  // Full ceremony (banner + sweep) only applies to a remix that carries
  // lineage - a quiet origin adoption with no parents gets the plain
  // adopted card, matching the comp's "Markets index" card.
  const hasCeremony = isAdopted && !!data.lineage && data.lineage.length > 0;
  const articleClass = `card ${cardStateClass[data.variant]}${hasCeremony ? ' adoption-event' : ''}`;

  return (
    <article className={articleClass}>
      <span className="node" />
      {hasCeremony && (
        <div className="adoption-banner">
          <span className="flare">
            <span className="dot" />
            Adopted into the build
          </span>
        </div>
      )}
      {/* The card links to its proposal page, but the footer rows carry their
          own anchors (the GitHub PR link). An anchor cannot be nested inside
          an anchor: React renders it, the HTML parser breaks the nesting, and
          any handler passed to close over the outer link makes this server
          component illegal. So the Link wraps only the non-interactive upper
          content and the footers sit beside it inside the same .card-body box.
          .card-body-link is display:block with no box of its own, so the
          rendered layout is unchanged. */}
      <div className="card-body">
        <Link href={`/proposal/${data.id}`} className="card-body-link">
          <div className="card-head">
            <div className={`avatar ${avatarClass(data.authorId)}`}>{initials(data.authorName)}</div>
            <span className="byline">
              {data.variant === 'fork-live' ? (
                <>
                  <b>{data.forkingByName}</b> is forking {data.authorName}&rsquo;s proposal
                </>
              ) : isAdopted ? (
                <>
                  <b>{data.authorName}&rsquo;s</b> proposal was adopted
                </>
              ) : (
                <>
                  <b>{data.authorName}</b> promoted from their agent
                </>
              )}
            </span>
            <div className="spacer" />
            <span className={`state-chip ${stateClassName[data.variant]}`}>{stateChipLabel[data.variant]}</span>
            <span className="timestamp">{relativeTime(data.createdAt)}</span>
          </div>

          <h3 className="intent">{data.intentSummary}</h3>

          {data.remixNoteBullets.length > 0 && !isAdopted && data.variant !== 'rejected' && (
            <div className="remix-note">
              <span className="rn-label">What changed from the parent</span>
              {data.remixNoteBullets.join(' ')}
            </div>
          )}

          {data.variant === 'rejected' && data.rejectionNote && (
            <div className="rejection-note">
              <span className="rn-label">Why this did not land</span>
              {data.rejectionNote}
            </div>
          )}

          {isAdopted && data.remixNoteBullets.length > 0 && (
            <div className="remix-note">
              <span className="rn-label">What changed from the parent</span>
              {data.remixNoteBullets.join(' ')}
            </div>
          )}

        </Link>

          {/* Credit lineage sits outside .card-body-link, not inside it. Each
              ancestor row names a different proposal and has to navigate
              there; nested inside the card-wide anchor it could only ever
              lead back to this card's own proposal, and an <a> inside an <a>
              is invalid HTML the parser silently unnests. Same treatment the
              proposal detail page gives its chain. */}
          {isAdopted && data.lineage && data.lineage.length > 0 && (
            <div className="lineage">
              <div className="lineage-title">Credit lineage</div>
              {data.lineage.map((entry) => {
                const label = (
                  <>
                    <b>{entry.displayName}</b> · {entry.intentSummary}
                  </>
                );
                const linkable = entry.proposalId != null && entry.proposalId !== data.id;
                return (
                  <div className="lineage-row" key={`${entry.contributorId}-${entry.hash}`}>
                    <span className={`l-dot ${entry.role}`} />
                    {linkable ? (
                      <Link href={`/proposal/${entry.proposalId}`} className="txt">
                        {label}
                      </Link>
                    ) : (
                      <span className="txt">{label}</span>
                    )}
                    <span className="spacer" />
                    <span className="hash">{shortHash(entry.hash)}</span>
                  </div>
                );
              })}
              {data.lineage.length > 1 && (
                <div className="lineage-foot">
                  Credit recorded for{' '}
                  <b>{data.lineage.filter((l) => l.role !== 'final').map((l) => l.displayName).join(', ')}</b>
                  {' '}on the merge.
                </div>
              )}
            </div>
          )}

          <div className="card-meta">
            {data.variant === 'fork-live' && (
              <span className="meta-item hot">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M5 3.8v4.6a3 3 0 0 0 3 3h3M11.8 3.8v2.4" />
                  <circle cx="5" cy="2.6" r="1.5" />
                  <circle cx="11.8" cy="2.6" r="1.5" />
                  <circle cx="11.8" cy="12.4" r="1.5" />
                </svg>
                fork in progress
              </span>
            )}
            {isAdopted && (
              <span className="meta-item adopted">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M2.5 8.5l3.5 3.5 7.5-8" />
                </svg>
                merged into the build
              </span>
            )}
            {!isAdopted && data.variant !== 'fork-live' && (
              <>
                <span className="meta-item">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M5 3.8v4.6a3 3 0 0 0 3 3h3" />
                    <circle cx="5" cy="2.6" r="1.5" />
                    <circle cx="11.8" cy="12.4" r="1.5" />
                  </svg>
                  {data.forkCount} {data.forkCount === 1 ? 'fork' : 'forks'}
                </span>
                {data.qaCount > 0 && (
                  <span className="meta-item">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path d="M14 10a2 2 0 0 1-2 2H6l-3 3V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z" />
                    </svg>
                    {data.qaCount} {data.qaCount === 1 ? 'note' : 'notes'}
                  </span>
                )}
              </>
            )}
            {isAdopted && data.mergeCommitSha ? (
              <span className="hash">merged @ {shortHash(data.mergeCommitSha)}</span>
            ) : (
              data.contentHash && <span className="hash">{shortHash(data.contentHash)}</span>
            )}
            {data.prNumber != null && data.prUrl && (
              <a className="meta-item" href={data.prUrl} target="_blank" rel="noopener noreferrer">
                PR #{data.prNumber}
              </a>
            )}
            <div className="spacer" />
            {data.variant === 'proposed' && (
              <>
                {data.proposalVersionId && (
                  <ForkButton
                    proposalId={data.id}
                    proposalVersionId={data.proposalVersionId}
                    signedIn={data.signedIn}
                    intentSummary={data.intentSummary}
                    authorName={data.authorName}
                    baseRef={data.baseRef ?? undefined}
                    baseSha={data.baseSha ?? undefined}
                    alreadyForkedAt={data.myForkAt ?? null}
                  />
                )}
              </>
            )}
            {isAdopted && data.prUrl && (
              <a className="mini-btn" href={data.prUrl} target="_blank" rel="noopener noreferrer">
                View in repo
              </a>
            )}
            {/* Rejected cards carry no reopen control: the card's own copy
                already points at the real path (fork it, promote a remix). */}
            {data.variant === 'superseded' &&
              (data.prUrl ? (
                <a className="mini-btn" href={data.prUrl} target="_blank" rel="noopener noreferrer">
                  View in repo
                </a>
              ) : (
                <Link className="mini-btn" href={`/proposal/${data.id}`}>
                  View
                </Link>
              ))}
          </div>
      </div>
    </article>
  );
}
