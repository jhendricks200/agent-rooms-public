'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useDialogPortal } from './useDialogPortal';
import { shortHash } from '@/lib/ui';

/**
 * Adopt: a maintainer merges this proposal's pull request into the room's
 * canonical build.
 *
 * The control is rendered only for a maintainer of the room. That is a
 * presentation decision layered on top of the real gate, never instead of
 * it: POST /api/adopt derives the acting contributor from the session and
 * 403s anyone who is not in rooms.maintainers, and nothing here can change
 * that. Not offering a control the server will refuse is politeness; the
 * refusal is the security.
 *
 * The merge itself is SHA-pinned by the route, which passes the version's
 * stored headCommit to GitHub as the merge `sha`. Nothing about that pin is
 * client-supplied: this component sends only roomId, proposalId and
 * proposalVersionId, and the confirm panel below shows the pin so the
 * maintainer can check it before agreeing.
 */
export interface AdoptButtonProps {
  roomId: string;
  proposalId: string;
  proposalVersionId: string;
  prNumber: number;
  /** owner/repo, for saying plainly where the merge lands. */
  repoRef: string;
  baseRef: string;
  headCommit: string;
  /** Everyone the merge records credit for, oldest ancestor first, this
   *  proposal's author last. */
  creditNames: string[];
}

/** The refusals worth telling apart. Everything else is 'other'. */
type RefusalKind =
  | 'head_moved'
  | 'merge_conflict'
  | 'already_adopted'
  | 'in_flight'
  | 'stale_released'
  | 'not_maintainer'
  | 'no_creds'
  | 'other';

interface Refusal {
  kind: RefusalKind;
  /** The heading a stranger reads first. */
  title: string;
  /** What actually happened and what to do about it, in plain words. */
  body: string;
  /** The server's own words, kept verbatim underneath. */
  raw: string;
  /** True when nothing went wrong: a control did its job. */
  working: boolean;
}

type State =
  | { status: 'idle' }
  | { status: 'confirm' }
  | { status: 'working' }
  | { status: 'done'; mergeSha: string | null; message: string }
  | { status: 'refused'; refusal: Refusal };

function classify(status: number, data: Record<string, unknown>): Refusal {
  const error = typeof data.error === 'string' ? data.error : '';
  const detail = typeof data.detail === 'string' ? data.detail : '';
  const mergeMessage =
    typeof (data.mergeResult as { message?: unknown } | undefined)?.message === 'string'
      ? ((data.mergeResult as { message: string }).message)
      : '';
  const raw = [error, mergeMessage, detail].filter(Boolean).join(' — ');

  // The adoption-integrity guarantee firing. This is the product working,
  // and it must not read like a fault of the person who clicked.
  if (mergeMessage.includes('expectedHeadCommit mismatch') || mergeMessage.includes('head moved')) {
    return {
      kind: 'head_moved',
      title: 'Nothing was merged, on purpose',
      body:
        'The pull request has new commits on it since this proposal was promoted, so the code you just read is not the code that would have been merged. Agent Rooms pins every adoption to the exact commit the room reviewed and asks GitHub to refuse anything else, which is what happened here. Reload the proposal to read the newer head, and adopt that instead.',
      raw,
      working: true,
    };
  }

  if (status === 502 && /not mergeable|merge conflict|conflict/i.test(detail)) {
    return {
      kind: 'merge_conflict',
      title: 'GitHub cannot merge this cleanly',
      body:
        'The base branch has moved in a way that conflicts with this change, so GitHub refused the merge. Nothing was recorded and the proposal is still open. The conflict has to be resolved on the pull request itself, then adopt again.',
      raw,
      working: false,
    };
  }

  if (status === 403) {
    return {
      kind: 'not_maintainer',
      title: 'Only a maintainer can adopt',
      body: 'This room does not list you as a maintainer, so the merge was refused. Ask a maintainer to adopt it.',
      raw,
      working: true,
    };
  }

  if (status === 503) {
    return {
      kind: 'no_creds',
      title: 'This deployment cannot reach GitHub',
      body:
        'Adoption means a real merge, and the GitHub credentials this instance needs are missing, so it refused rather than record an adoption it could not verify. Nothing was recorded.',
      raw,
      working: true,
    };
  }

  if (error.includes('already been adopted')) {
    return {
      kind: 'already_adopted',
      title: 'Already adopted',
      body: 'This proposal has been merged once already, and a proposal is only ever adopted once. Reload to see the record.',
      raw,
      working: true,
    };
  }

  if (error.includes('already in flight')) {
    return {
      kind: 'in_flight',
      title: 'An adoption is running right now',
      body:
        'Someone else pressed adopt on this proposal moments ago and that merge has not finished. Nothing was merged twice. Wait a moment and reload.',
      raw,
      working: true,
    };
  }

  if (error.includes('stale adoption attempt')) {
    return {
      kind: 'stale_released',
      title: 'An unfinished attempt was cleared',
      body:
        'A previous adoption stopped part way and never merged. It has been cleared out, nothing was merged, and adopting again now will work.',
      raw,
      working: true,
    };
  }

  return {
    kind: 'other',
    title: 'The room did not adopt this',
    body: 'Nothing was merged and nothing was recorded.',
    raw: raw || `HTTP ${status}`,
    working: false,
  };
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function AdoptButton({
  roomId,
  proposalId,
  proposalVersionId,
  prNumber,
  repoRef,
  baseRef,
  headCommit,
  creditNames,
}: AdoptButtonProps) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const router = useRouter();

  async function submit() {
    setState({ status: 'working' });
    try {
      const res = await fetch('/api/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, proposalId, proposalVersionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ status: 'refused', refusal: classify(res.status, data) });
        // A refusal can still have changed what the page should show (a
        // recovered attempt, an adoption someone else completed), so the
        // record underneath is re-read either way.
        router.refresh();
        return;
      }
      setState({
        status: 'done',
        mergeSha: (data.adoption?.mergeCommitSha as string | undefined) ?? null,
        message: (data.mergeResult?.message as string | undefined) ?? 'Merged.',
      });
      // Deliberately NOT refreshing here. A refresh re-renders the server
      // tree, the page stops offering adopt on an adopted proposal, this
      // whole component unmounts, and the receipt vanishes before it can be
      // read. The refresh happens when the receipt is dismissed instead,
      // which still turns the page behind it into its adopted state without
      // anyone reloading.
    } catch {
      setState({
        status: 'refused',
        refusal: {
          kind: 'other',
          title: 'The adopt request never reached the room',
          body: 'Nothing was merged. Check your connection and try again.',
          raw: 'network error',
          working: false,
        },
      });
    }
  }

  return (
    <>
      <button
        className="adopt-btn"
        type="button"
        onClick={() => setState({ status: 'confirm' })}
        disabled={state.status === 'working'}
      >
        <CheckIcon />
        {state.status === 'working' ? 'Merging…' : 'Adopt into the build'}
      </button>

      {(state.status === 'confirm' || state.status === 'working') && (
        <AdoptConfirmSheet
          prNumber={prNumber}
          repoRef={repoRef}
          baseRef={baseRef}
          headCommit={headCommit}
          creditNames={creditNames}
          working={state.status === 'working'}
          onCancel={() => setState({ status: 'idle' })}
          onConfirm={submit}
        />
      )}

      {state.status === 'done' && (
        <AdoptReceiptSheet
          mergeSha={state.mergeSha}
          message={state.message}
          baseRef={baseRef}
          repoRef={repoRef}
          creditNames={creditNames}
          onClose={() => {
            setState({ status: 'idle' });
            router.refresh();
          }}
        />
      )}

      {state.status === 'refused' && (
        <AdoptRefusalSheet refusal={state.refusal} onClose={() => setState({ status: 'idle' })} />
      )}
    </>
  );
}

/* ---------------------------------------------------------------------- */

function AdoptConfirmSheet({
  prNumber,
  repoRef,
  baseRef,
  headCommit,
  creditNames,
  working,
  onCancel,
  onConfirm,
}: {
  prNumber: number;
  repoRef: string;
  baseRef: string;
  headCommit: string;
  creditNames: string[];
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { container, boxRef } = useDialogPortal(onCancel);
  if (!container) return null;

  return createPortal(
    <div className="modal-overlay" onClick={working ? undefined : onCancel}>
      <div
        className="modal-box fork-sheet adopt-sheet"
        onClick={(e) => e.stopPropagation()}
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adopt-confirm-title"
      >
        <div className="modal-head">
          <span className="head-glyph adopt" aria-hidden="true">
            <CheckIcon />
          </span>
          <div className="head-txt">
            <h2 id="adopt-confirm-title">Adopt this into the build?</h2>
            <p>This merges a real pull request. It is the one action here that changes the room&rsquo;s code.</p>
          </div>
          <button className="modal-close" onClick={onCancel} aria-label="Close" type="button" disabled={working}>
            <CloseIcon />
          </button>
        </div>

        <div className="lands">
          <div className="lands-label">Merging</div>
          <div className="path-field">
            <code>
              <span className="dir">{repoRef} #</span>
              <span className="leaf">{prNumber}</span>
              <span className="dir"> → {baseRef}</span>
            </code>
          </div>
        </div>

        <ul className="fork-facts">
          <li>
            <span className="ff-mark ff-yes" aria-hidden="true" />
            <span>
              <b>
                Merges pull request #{prNumber} into <span className="mono">{baseRef}</span> on{' '}
                <span className="mono">{repoRef}</span>.
              </b>{' '}
              On GitHub, for real, right now.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-yes" aria-hidden="true" />
            <span>
              <b>
                Pinned to <span className="mono">{shortHash(headCommit)}</span>.
              </b>{' '}
              The exact commit this proposal was promoted at. If the pull request has moved on since, GitHub refuses
              the merge and nothing is recorded.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-yes" aria-hidden="true" />
            <span>
              <b>Records credit for {creditNames.length === 1 ? creditNames[0] : creditNames.join(', ')}.</b>{' '}
              The whole chain that led here, written into the room&rsquo;s record against the merge commit.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-no" aria-hidden="true" />
            <span>
              <b>Cannot be undone from here.</b> A proposal is adopted once. Reverting a merge is a job for the
              repository afterwards.
            </span>
          </li>
        </ul>

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onCancel} disabled={working}>
            Cancel
          </button>
          <button className="btn-primary adopt" type="button" onClick={onConfirm} disabled={working}>
            {working ? 'Merging…' : 'Merge and adopt'}
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}

/* ---------------------------------------------------------------------- */

function AdoptReceiptSheet({
  mergeSha,
  message,
  baseRef,
  repoRef,
  creditNames,
  onClose,
}: {
  mergeSha: string | null;
  message: string;
  baseRef: string;
  repoRef: string;
  creditNames: string[];
  onClose: () => void;
}) {
  const { container, boxRef } = useDialogPortal(onClose);
  if (!container) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box fork-sheet adopt-sheet"
        onClick={(e) => e.stopPropagation()}
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adopt-receipt-title"
      >
        <div className="modal-head">
          <span className="head-glyph adopt" aria-hidden="true">
            <CheckIcon />
          </span>
          <div className="head-txt">
            <h2 id="adopt-receipt-title">Adopted into the build</h2>
            <p>{message}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="lands">
          <div className="lands-label">Merged to</div>
          <div className="path-field">
            <code>
              <span className="dir">{repoRef} · {baseRef} @ </span>
              <span className="leaf">{mergeSha ? shortHash(mergeSha) : 'merge commit recorded'}</span>
            </code>
          </div>
          <p className="worktree-note">
            Credit recorded for <b>{creditNames.join(', ')}</b>. The proposal now reads as adopted, and its provenance
            carries the merge commit.
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn-primary adopt" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}

/* ---------------------------------------------------------------------- */

function AdoptRefusalSheet({ refusal, onClose }: { refusal: Refusal; onClose: () => void }) {
  const { container, boxRef } = useDialogPortal(onClose);
  if (!container) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-box fork-sheet adopt-sheet refusal ${refusal.working ? 'guard' : 'fault'}`}
        onClick={(e) => e.stopPropagation()}
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adopt-refusal-title"
      >
        <div className="modal-head">
          <span className="head-glyph" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M8 3.5v5.2M8 11.8v.4" />
              <circle cx="8" cy="8" r="6.4" />
            </svg>
          </span>
          <div className="head-txt">
            <h2 id="adopt-refusal-title">{refusal.title}</h2>
            <p>{refusal.body}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        {refusal.working && (
          <p className="refusal-guard-note">
            This is a control doing its job, not a mistake you made. Adoption is only ever recorded when a real merge of
            the exact reviewed commit actually happened.
          </p>
        )}

        <div className="lands">
          <div className="lands-label">What the room said</div>
          <div className="path-field">
            <code>
              <span className="leaf">{refusal.raw}</span>
            </code>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}
