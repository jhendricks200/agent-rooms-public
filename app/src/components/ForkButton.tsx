'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { parseDiffRef } from '@/lib/diff';
import { shortHash } from '@/lib/ui';
import { useDialogPortal } from './useDialogPortal';

export interface ForkBundleResult {
  artifact: string;
  baseRef: string;
  baseSha: string;
  lineageChain: { id: string; parentProposalIds: string[] }[];
  intentSummary: string;
  remixNote: unknown;
}

/** Resolved beside the bundle by /api/fork, never inside it: the bundle is
 *  five parts and no more. */
export interface ForkChainNode {
  id: string;
  authorName: string | null;
  intentSummary: string | null;
  headCommit: string | null;
  isRemix: boolean;
  missing: boolean;
}

export interface ForkButtonProps {
  proposalId: string;
  proposalVersionId: string;
  signedIn: boolean;
  /** What the reader is deciding about, named in the confirm panel. */
  intentSummary?: string;
  authorName?: string;
  /** Shown before the fork when the caller already knows them. */
  baseRef?: string;
  baseSha?: string;
  /** ISO timestamp of this reader's own existing fork of this version. */
  alreadyForkedAt?: string | null;
}

interface ForkResult {
  bundle: ForkBundleResult;
  chain: ForkChainNode[];
  alreadyForked: boolean;
}

type State =
  | { status: 'idle' }
  | { status: 'confirm' }
  | { status: 'loading' }
  | { status: 'done'; result: ForkResult }
  | { status: 'error'; message: string };

// The bundle's remix note is stored as opaque JSON; the sheet only needs the
// bullets, and an absent note is a recorded choice rather than an error.
function noteBullets(remixNote: unknown): string[] {
  const bullets = (remixNote as { bullets?: unknown } | null | undefined)?.bullets;
  if (!Array.isArray(bullets)) return [];
  return bullets.filter((b): b is string => typeof b === 'string' && b.trim().length > 0);
}

function ForkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 3.8v4.6a3 3 0 0 0 3 3h3" />
      <circle cx="5" cy="2.6" r="1.5" />
      <circle cx="11.8" cy="12.4" r="1.5" />
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

export function ForkButton({
  proposalId,
  proposalVersionId,
  signedIn,
  intentSummary,
  authorName,
  baseRef,
  baseSha,
  alreadyForkedAt,
}: ForkButtonProps) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const router = useRouter();
  const mine = alreadyForkedAt != null;

  async function submitFork() {
    if (!signedIn) return;
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, proposalVersionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: data.error ? JSON.stringify(data.error) : 'Fork failed' });
        return;
      }
      setState({
        status: 'done',
        result: { bundle: data.bundle, chain: data.chain ?? [], alreadyForked: data.alreadyForked === true },
      });
      // The forks list and the fork count on the page behind this sheet are
      // server-rendered, and a fork just changed both. Refresh now rather
      // than on close, so what is underneath is already correct when the
      // reader dismisses the receipt.
      router.refresh();
    } catch {
      setState({ status: 'error', message: 'Network error' });
    }
  }

  function close() {
    setState({ status: 'idle' });
  }

  return (
    <>
      <button
        className={mine ? 'mini-btn' : 'mini-btn primary'}
        type="button"
        onClick={() => (mine ? submitFork() : setState({ status: 'confirm' }))}
        disabled={state.status === 'loading' || !signedIn}
        title={
          mine
            ? 'You have already forked this version. Opens the fork you already have; nothing new is recorded.'
            : undefined
        }
      >
        {state.status === 'loading'
          ? mine
            ? 'Opening…'
            : 'Recording…'
          : !signedIn
            ? 'Sign in to fork'
            : mine
              ? 'Your fork'
              : 'Fork'}
      </button>

      {state.status === 'confirm' && (
        <ForkConfirmSheet
          intentSummary={intentSummary}
          authorName={authorName}
          baseRef={baseRef}
          baseSha={baseSha}
          onCancel={close}
          onConfirm={submitFork}
        />
      )}

      {state.status === 'done' && (
        <ForkReceiptSheet result={state.result} authorName={authorName} onClose={close} />
      )}

      {state.status === 'error' && <div className="scan-dirty">{state.message}</div>}
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* Before: what is about to happen, in the terms the system actually acts in. */

function ForkConfirmSheet({
  intentSummary,
  authorName,
  baseRef,
  baseSha,
  onCancel,
  onConfirm,
}: {
  intentSummary?: string;
  authorName?: string;
  baseRef?: string;
  baseSha?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { container, boxRef } = useDialogPortal(onCancel);
  if (!container) return null;
  const whose = authorName ? `${authorName}’s` : 'This';

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-box fork-sheet"
        onClick={(e) => e.stopPropagation()}
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-confirm-title"
      >
        <div className="modal-head">
          <span className="head-glyph" aria-hidden="true">
            <ForkIcon />
          </span>
          <div className="head-txt">
            <h2 id="fork-confirm-title">Fork this proposal?</h2>
            <p>
              {whose} work, pinned to the commit it was written against.
              {intentSummary ? ` ${intentSummary}` : ''}
            </p>
          </div>
          <button className="modal-close" onClick={onCancel} aria-label="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        {baseRef && baseSha && (
          <div className="lands">
            <div className="lands-label">Pinned to</div>
            <div className="path-field">
              <code>
                <span className="dir">{baseRef} @ </span>
                <span className="leaf">{baseSha}</span>
              </code>
            </div>
          </div>
        )}

        {/* Every line here is a claim about what the fork request does. The
            receipt that follows must be able to repeat all four. */}
        <ul className="fork-facts">
          <li>
            <span className="ff-mark ff-yes" aria-hidden="true" />
            <span>
              <b>Records a fork on this proposal, credited to you.</b> It appears in the room’s forks
              list under your name, and it is what puts you in the credit chain when you promote your
              version.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-yes" aria-hidden="true" />
            <span>
              <b>Hands you the bundle.</b> The changed files, the base ref and the exact commit it is
              pinned to, the credit chain, the intent, and the remix note. Nothing else, ever.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-no" aria-hidden="true" />
            <span>
              <b>Writes nothing to your machine.</b> Agent Rooms cannot reach your disk. No branch, no
              worktree, no checkout: you copy the bundle into your own workspace yourself.
            </span>
          </li>
          <li>
            <span className="ff-mark ff-no" aria-hidden="true" />
            <span>
              <b>Opens no pull request and changes no code.</b> Promote does that, later, when you
              decide your version is ready.
            </span>
          </li>
        </ul>

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" type="button" onClick={onConfirm}>
            Record the fork
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}

/* ---------------------------------------------------------------------- */
/* After: the receipt. design/screen-fork.html's composition, with the
   worktree claim replaced by what actually happened. */

function ForkReceiptSheet({
  result,
  authorName,
  onClose,
}: {
  result: ForkResult;
  authorName?: string;
  onClose: () => void;
}) {
  const { container, boxRef } = useDialogPortal(onClose);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const { bundle, chain, alreadyForked } = result;
  const bulletList = noteBullets(bundle.remixNote);
  // The artifact is the structured file-change list in lib/diff. Shown as
  // the comp's file list when it parses, and as the raw payload when it is
  // an older unified-diff fixture.
  const parsedArtifact = parseDiffRef(bundle.artifact);
  const changed = parsedArtifact.ok ? parsedArtifact.diff?.files ?? null : null;
  // Oldest first, and the proposal being forked is the last node of the
  // chain the reader is joining.
  const chainOldestFirst = [...chain].reverse();

  async function copyBundle() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  if (!container) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box fork-sheet"
        onClick={(e) => e.stopPropagation()}
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-receipt-title"
      >
        <div className="modal-head">
          <span className="head-glyph" aria-hidden="true">
            <ForkIcon />
          </span>
          <div className="head-txt">
            <h2 id="fork-receipt-title">{alreadyForked ? 'You already forked this' : 'Fork recorded'}</h2>
            <p>{bundle.intentSummary}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="lands">
          <div className="lands-label">Pinned to</div>
          <div className="path-field">
            <code>
              <span className="dir">{bundle.baseRef} @ </span>
              <span className="leaf">{bundle.baseSha}</span>
            </code>
          </div>
          <p className="worktree-note">
            {alreadyForked ? (
              <>
                Your fork was already on record, so <b>nothing new was recorded</b>. This is the same
                bundle it carries.
              </>
            ) : (
              <>
                Recorded on this proposal, credited to you, and visible to the room.{' '}
                <b>Nothing was written to your machine.</b>
              </>
            )}
          </p>
        </div>

        {/* The honest next step. There is no workspace to open, so the only
            thing that moves this forward is the reader carrying the bundle
            somewhere themselves. */}
        <div className="fork-next">
          <div className="fn-head">Your next step</div>
          <p>
            Copy the bundle, rebuild it in your own workspace at{' '}
            <span className="mono">{shortHash(bundle.baseSha)}</span>, and remix it with your agent.
            Promote your version back to the room when it is ready: that is the step that joins you to
            the credit chain below.
          </p>
        </div>

        {bulletList.length > 0 ? (
          <section className="fork-note">
            <div className="note-head">
              <span className="who">{authorName ? `Note from ${authorName}` : 'Remix note'}</span>
              <span className="spacer" />
              <span className="tag">written for you</span>
            </div>
            <ul>
              {bulletList.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="no-note">
            <div className="nn-head">
              {authorName ? `${authorName} sent this one without a remix note.` : 'Sent without a remix note.'}
            </div>
          </div>
        )}

        <details className="disclosure">
          <summary className="disc-head">
            <span className="disc-emblem e-change" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M6 2.5 3 8l3 5.5M10 2.5 13 8l-3 5.5" />
              </svg>
            </span>
            <span className="disc-name">The change</span>
            <span className="spacer" />
            <span className="stat">{changed ? `${changed.length} ${changed.length === 1 ? 'file' : 'files'}` : 'artifact'}</span>
            <span className="chev" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </span>
          </summary>
          <div className="disc-panel">
            {changed ? (
              <div className="file-list">
                {changed.map((file) => (
                  <div className="file-row" key={file.path}>
                    <span className={`mk ${file.changeType === 'add' ? 'add' : file.changeType === 'delete' ? 'del' : 'mod'}`}>
                      {file.changeType === 'add' ? '+' : file.changeType === 'delete' ? '−' : '~'}
                    </span>
                    <span className="fp">{file.path}</span>
                  </div>
                ))}
              </div>
            ) : (
              <pre>{bundle.artifact}</pre>
            )}
          </div>
        </details>

        <details className="disclosure">
          <summary className="disc-head">
            <span className="disc-emblem e-chain" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6" />
                <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
              </svg>
            </span>
            <span className="disc-name">Credit chain</span>
            <span className="spacer" />
            {/* Names while they fit, a count once they do not. Either way,
                never a raw id. */}
            <span className="stat">
              {chainOldestFirst.length > 0 && chainOldestFirst.length <= 3
                ? chainOldestFirst
                    .map((n) => (n.missing ? 'missing' : n.authorName ?? 'unknown'))
                    .concat('you')
                    .join(' → ')
                : `${chainOldestFirst.length + 1} steps`}
            </span>
            <span className="chev" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </span>
          </summary>
          <div className="disc-panel">
            <div className="chain-list">
              {chainOldestFirst.map((node) => (
                <div className="chain-row" key={node.id}>
                  <span className={`cdot ${node.isRemix ? 'remix' : ''}`} />
                  {node.missing ? (
                    <span className="cwho broken">missing from the record</span>
                  ) : (
                    <>
                      <span className="cwho">{node.authorName ?? 'Unknown'}</span>
                      <span className="cwhat">{node.intentSummary ?? '(no published version)'}</span>
                    </>
                  )}
                  <span className="spacer" />
                  <span className="sha">{node.headCommit ? shortHash(node.headCommit) : node.id.slice(0, 12)}</span>
                </div>
              ))}
              <div className="chain-row pending">
                <span className="cdot you" />
                <span className="cwho">You</span>
                <span className="cwhat">join the chain when you promote your version</span>
              </div>
            </div>
          </div>
        </details>

        <div className="modal-actions">
          {copied !== 'idle' && (
            <span className={copied === 'ok' ? 'copy-said' : 'copy-said fail'}>
              {copied === 'ok'
                ? 'Bundle copied to your clipboard.'
                : 'Could not reach the clipboard. Select the bundle from the disclosures above.'}
            </span>
          )}
          <button className="btn-secondary" type="button" onClick={onClose}>
            Done
          </button>
          <button className="btn-primary" type="button" onClick={copyBundle}>
            Copy the bundle
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}
