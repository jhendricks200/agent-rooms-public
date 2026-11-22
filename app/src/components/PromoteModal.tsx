'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogPortal } from './useDialogPortal';
import { scanForSecrets } from '@/lib/secretScan';
import { MIN_BULLETS, MAX_BULLETS } from '@/lib/remixNote';
import { parseAgentDraft, type DraftFile, type ParsedAgentDraft } from '@/lib/agentDraft';

// Every room in this app is created against a repo whose default branch is
// main (scripts/create-room-repo.ts), and the Room row does not carry a
// default-branch column, so this is the prefill rather than a placeholder
// dressed up as one. It stays editable for a repo that differs.
export const DEFAULT_BASE_REF = 'main';

// GitHub assigns the head commit when promote pushes the branch: the
// server overwrites whatever is sent here with the SHA it actually
// committed (api/proposals/route.ts, the pending-to-published
// finalization). Asking the user to invent one was asking for a value that
// cannot exist yet, so the field is derived by default and carries this
// sentinel, exactly as the Stage 0 harness does.
const PENDING_HEAD_COMMIT = 'pending';

// How many parsed drafts the picker offers. The list is a shortcut, not an
// archive: past four or five the sheet stops being a choice and becomes a
// second feed to read.
const MAX_PICKER_DRAFTS = 5;
const MAX_LISTED_FILES = 6;

/**
 * A fork this contributor already holds in this room, offered as the parent
 * the promote will be credited against.
 *
 * Lineage is recorded from the fork row and nothing else. The fork is the
 * only place the app already knows that this person took someone's work: it
 * ties (contributor, proposal version) together at the moment the bundle was
 * handed over. Inventing a second piece of state to track "what am I
 * remixing" would let the two disagree.
 */
export interface PromoteParentOption {
  proposalId: string;
  /** The exact version that was forked; shown so the credit is checkable. */
  proposalVersionId: string;
  intentSummary: string;
  authorName: string;
  /** ISO timestamp of the fork row. */
  forkedAt: string;
  headCommit: string;
}

export interface PromoteModalProps {
  roomId: string;
  onClose: () => void;
  onPromoted: () => void;
  /** 'agent' when reached from an agent draft: a confirmation, not a form. */
  source?: 'agent' | 'manual';
  githubRepoRef?: string;
  /**
   * Forks this contributor holds in this room, most recent first. The most
   * recent one is preselected as the parent (see the note above the picker);
   * an empty list means this promote can only be a root proposal.
   */
  parentOptions?: PromoteParentOption[];
  // Prefill from an agent draft (the "Promote to room" affordance on the
  // agent's output).
  initialIntentSummary?: string;
  initialDiffRef?: string;
  initialBullets?: string[];
  initialFiles?: DraftFile[];
}

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string };

interface PickerDraft {
  id: string;
  createdAt: string;
  draft: ParsedAgentDraft;
}

function Required() {
  return (
    <span className="field-req" aria-hidden="true">
      required
    </span>
  );
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** formatAge returns a bare duration; only some of them take "ago". */
function agoLabel(iso: string): string {
  const age = formatAge(iso);
  return age === 'just now' ? 'just now' : `${age} ago`;
}

function marker(changeType: DraftFile['changeType']): { glyph: string; className: string } {
  if (changeType === 'add') return { glyph: '+', className: 'add' };
  if (changeType === 'delete') return { glyph: '−', className: 'del' };
  return { glyph: '~', className: 'mod' };
}

function formatLabel(format: ParsedAgentDraft['format']): string {
  return format === 'structured' ? 'structured' : 'unified diff';
}

export function PromoteModal({
  roomId,
  onClose,
  onPromoted,
  source = 'manual',
  githubRepoRef,
  initialIntentSummary,
  initialDiffRef,
  initialBullets,
  initialFiles,
  parentOptions,
}: PromoteModalProps) {
  const fromAgent = source === 'agent';
  // Attribution rule: the most recent fork this contributor holds in this
  // room is preselected as the parent. Recency is the only signal the record
  // actually carries about which fork someone is working from, and the
  // alternative rules are worse: attributing every fork would credit work
  // this change never touched, and attributing none by default is exactly
  // the bug this closes. It is a default, not a verdict, so the picker below
  // lets the promoter choose a different fork or no parent at all.
  const forkParents = useMemo(() => parentOptions ?? [], [parentOptions]);
  const [parentProposalId, setParentProposalId] = useState<string | null>(
    forkParents.length > 0 ? forkParents[0].proposalId : null,
  );
  const chosenParent = forkParents.find((p) => p.proposalId === parentProposalId) ?? null;
  const [intentSummary, setIntentSummary] = useState(initialIntentSummary ?? '');
  const [diffRef, setDiffRef] = useState(initialDiffRef ?? '');
  const [baseRef, setBaseRef] = useState(DEFAULT_BASE_REF);
  // Derived by default; the manual escape hatch stays for a promote into a
  // room with no linked repo, where the value is stored verbatim.
  const [headCommitManual, setHeadCommitManual] = useState(false);
  const [headCommit, setHeadCommit] = useState(PENDING_HEAD_COMMIT);
  // Whether the raw diff is on screen. The composer door no longer opens on
  // a bare textarea: with nothing attached it shows the empty state, and
  // pasting is a deliberate choice (setPasteMode) rather than the default.
  const [showDiff, setShowDiff] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [skipRemixNote, setSkipRemixNote] = useState(!initialBullets || initialBullets.length === 0);
  const [bullets, setBullets] = useState<string[]>(
    initialBullets && initialBullets.length > 0 ? initialBullets : Array(MIN_BULLETS).fill(''),
  );
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  // ---- the drafts picker ----
  // The app already parses every agent reply into a draft; this is the
  // first time the composer door gets to see them. No new endpoint: the
  // same GET the agent pane loads its history from, parsed with the same
  // lib/agentDraft.ts the sidebar's promote card uses.
  const [drafts, setDrafts] = useState<PickerDraft[] | null>(fromAgent ? [] : null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [pickedFiles, setPickedFiles] = useState<DraftFile[] | null>(null);

  useEffect(() => {
    if (fromAgent) return;
    let cancelled = false;
    fetch(`/api/agent/message?roomId=${encodeURIComponent(roomId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!data || !Array.isArray(data.messages)) {
          setDrafts([]);
          return;
        }
        const parsed: PickerDraft[] = (data.messages as { id: string; role: string; content: string; createdAt: string }[])
          .filter((m) => m.role === 'assistant')
          .map((m) => ({ id: m.id, createdAt: m.createdAt, draft: parseAgentDraft(m.content) }))
          .filter((entry): entry is PickerDraft => entry.draft !== null)
          .reverse()
          .slice(0, MAX_PICKER_DRAFTS);
        setDrafts(parsed);
      })
      .catch(() => {
        if (!cancelled) setDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fromAgent, roomId]);

  const files = pickedFiles ?? initialFiles ?? [];
  // Something is attached when a draft filled the form or the agent door
  // prefilled it. Pasting is the third shape, chosen deliberately.
  const attached = fromAgent || pickedId !== null;

  function choose(entry: PickerDraft) {
    const d = entry.draft;
    setPickedId(entry.id);
    setPickedFiles(d.files);
    setIntentSummary(d.intentSummary);
    setDiffRef(d.diffRef);
    setBullets(d.bullets.length > 0 ? d.bullets : Array(MIN_BULLETS).fill(''));
    setSkipRemixNote(d.bullets.length === 0);
    setShowDiff(false);
    setPasteMode(false);
  }

  // The fallback, demoted but never removed. The picker folds behind its
  // own disclosure rather than vanishing, because changing your mind back
  // is one click.
  function goToPaste() {
    setPickedId(null);
    setPickedFiles(null);
    setPasteMode(true);
    setShowDiff(true);
    setDraftsOpen(false);
  }

  const effectiveBullets = useMemo(() => (skipRemixNote ? [] : bullets), [skipRemixNote, bullets]);
  const effectiveHeadCommit = headCommitManual ? headCommit : PENDING_HEAD_COMMIT;

  const scan = useMemo(() => {
    const text = [diffRef, ...effectiveBullets].join('\n');
    return scanForSecrets(text);
  }, [diffRef, effectiveBullets]);

  const bulletsValid = skipRemixNote || (bullets.length >= MIN_BULLETS && bullets.every((b) => b.trim().length > 0));

  // Naming the missing pieces, rather than leaving a disabled button to be
  // guessed at. Kept separate from the secret-scan block below so a
  // blocked promote never reads as an incomplete one.
  const missing = useMemo(() => {
    const out: string[] = [];
    if (!intentSummary.trim()) out.push('Intent');
    if (!diffRef.trim()) out.push('Changes');
    if (!baseRef.trim()) out.push('Base branch');
    if (!effectiveHeadCommit.trim()) out.push('Head commit');
    if (!bulletsValid) out.push('Remix note (every bullet needs text, or skip the note)');
    return out;
  }, [intentSummary, diffRef, baseRef, effectiveHeadCommit, bulletsValid]);

  const canPublish = missing.length === 0 && scan.clean && submit.status !== 'submitting';

  // Anything typed or prefilled into the changes field is work that a stray
  // Escape, Cancel, or scrim click would destroy.
  const dirty = diffRef.trim().length > 0;

  function requestClose() {
    if (dirty && submit.status !== 'submitting') {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  // Escape, focus containment, focus restore and inertness for the page
  // behind the scrim all live in the hook, shared with the fork sheet. The
  // one exception is the point of this sheet: the agent column is left
  // pointer-interactive and out of the inert set, because it is the most
  // likely place the work being promoted is being read from.
  const { container, boxRef } = useDialogPortal(requestClose, { keepInteractive: '.agent-pane' });

  function addBullet() {
    setBullets((prev) => (prev.length >= MAX_BULLETS ? prev : [...prev, '']));
  }
  function removeBullet(index: number) {
    setBullets((prev) => (prev.length <= MIN_BULLETS ? prev : prev.filter((_, i) => i !== index)));
  }
  function updateBullet(index: number, value: string) {
    setBullets((prev) => prev.map((b, i) => (i === index ? value : b)));
  }

  async function handlePublish() {
    if (!canPublish) return;
    setSubmit({ status: 'submitting' });
    try {
      const res = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          // The credit chain. An empty array is a root proposal, which is a
          // real choice here rather than the hardcoded default it used to be.
          parentProposalIds: parentProposalId ? [parentProposalId] : [],
          intentSummary: intentSummary.trim(),
          diffRef,
          baseRef: baseRef.trim(),
          headCommit: effectiveHeadCommit.trim(),
          remixNote: {
            bullets: effectiveBullets.map((b) => b.trim()).filter(Boolean),
            generatedBy: 'agent-draft',
            authorEdited: !skipRemixNote,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmit({ status: 'error', message: data.error ? JSON.stringify(data.error) : 'Promote failed' });
        return;
      }
      onPromoted();
    } catch {
      setSubmit({ status: 'error', message: 'Network error' });
    }
  }

  // The agent pane carries a backdrop-filter, which makes it the containing
  // block for position:fixed descendants: rendered in place, this modal was
  // clipped to the sidebar's width, with half its fields off-screen. Now that
  // the agent output is the primary way in, it has to escape to the document.
  // No mount guard is needed: this component only ever renders in response to
  // a click, so it is never part of a server render.
  if (!container) return null;

  const shownFiles = files.slice(0, MAX_LISTED_FILES);
  const overflowFiles = files.length - shownFiles.length;

  return createPortal(
    <>
      {/* The scrim stops at the agent column's left edge instead of covering
          the screen: promote is still a deliberate crossing, but the place
          the work is being read from stays lit. */}
      <div className="promote-scrim" onMouseDown={requestClose} />

      <div
        className="promote-sheet"
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-modal-title"
      >
        <div className="sheet-head">
          <span className="head-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </span>
          <div className="head-txt">
            <h2 id="promote-modal-title">Promote to room</h2>
            <p>
              {fromAgent
                ? 'Your agent’s draft, ready to cross into the room. Check it over, then promote.'
                : 'Private to shared, in one deliberate step.'}
              {githubRepoRef ? (
                <>
                  {' '}
                  This opens a pull request on <code>{githubRepoRef}</code>.
                </>
              ) : null}
            </p>
          </div>
          <button className="modal-close" onClick={requestClose} aria-label="Close promote" type="button">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="sheet-body">
          {/* ---- the drafts picker ----
              Only on the composer door. The agent door arrived carrying its
              draft already, so a list of others would be noise. */}
          {!fromAgent && (
            <section className="drafts" aria-labelledby="promote-drafts-head">
              <button
                className="drafts-head"
                type="button"
                id="promote-drafts-head"
                aria-expanded={draftsOpen}
                aria-controls="promote-drafts-list"
                onClick={() => setDraftsOpen((v) => !v)}
              >
                <span className="h">From your agent</span>
                <span className="spacer" />
                <span className="n">
                  {drafts === null ? 'loading' : `${drafts.length} recent`}
                </span>
                <span className="chev" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </span>
              </button>

              {draftsOpen && (
                <div className="drafts-list" id="promote-drafts-list" data-picked={pickedId ? 'yes' : 'no'}>
                  {drafts === null && <p className="drafts-empty">Looking for drafts in your agent session…</p>}
                  {drafts !== null && drafts.length === 0 && (
                    <p className="drafts-empty">
                      Your agent has not drafted a change in this room yet. Ask it for one in the column on the right, or
                      paste a diff below.
                    </p>
                  )}
                  {drafts?.map((entry) => {
                    const d = entry.draft;
                    const picked = pickedId === entry.id;
                    const listed = d.files.slice(0, MAX_LISTED_FILES);
                    return (
                      <button
                        className="draft"
                        type="button"
                        key={entry.id}
                        aria-pressed={picked}
                        onClick={() => choose(entry)}
                      >
                        <span className="draft-top">
                          <span className="t">{d.intentSummary || 'Draft from your agent'}</span>
                          <span className="spacer" />
                          <span className="when">{formatAge(entry.createdAt)}</span>
                          <span className="tick" aria-hidden="true">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 8.4l3 3 7-7.6" />
                            </svg>
                          </span>
                        </span>
                        <span className="draft-meta">
                          <span>
                            {d.files.length} file{d.files.length === 1 ? '' : 's'}
                          </span>
                          <span>
                            {d.bullets.length === 0
                              ? 'no note'
                              : `${d.bullets.length} note bullet${d.bullets.length === 1 ? '' : 's'}`}
                          </span>
                          <span>{formatLabel(d.format)}</span>
                        </span>
                        {listed.length > 0 && (
                          <span className="draft-files">
                            {listed.map((f, i) => {
                              const m = marker(f.changeType);
                              return (
                                <span className={m.className} key={`${f.path}-${i}`}>
                                  {m.glyph} {f.path}
                                </span>
                              );
                            })}
                            {d.files.length > listed.length && <span>and {d.files.length - listed.length} more</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}

                  <p className="drafts-fallback">
                    Work that did not come from your agent?{' '}
                    <button className="link-btn" type="button" onClick={goToPaste}>
                      Paste a diff instead
                    </button>
                    .
                  </p>
                </div>
              )}
            </section>
          )}

          <div className="field">
            <label htmlFor="intent">
              Intent <Required />
            </label>
            <textarea
              id="intent"
              aria-required="true"
              placeholder="What does this change do, and why?"
              value={intentSummary}
              onChange={(e) => setIntentSummary(e.target.value)}
            />
            {attached && (
              <span className="field-hint">
                Filled from your agent’s draft. Edit it freely, this is what the room reads first.
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="diff">
              Changes <Required />
            </label>
            {attached && !showDiff ? (
              <div className="prefilled-row">
                <span className="prefilled-summary">
                  {files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'} from your agent` : 'Change from your agent'}
                  {files.length > 0 && (
                    <span className="prefilled-paths">
                      {shownFiles.map((f) => f.path).join(', ')}
                      {overflowFiles > 0 ? `, and ${overflowFiles} more` : ''}
                    </span>
                  )}
                </span>
                <button className="btn-secondary" type="button" onClick={() => setShowDiff(true)}>
                  Review and edit
                </button>
              </div>
            ) : attached || pasteMode ? (
              <>
                <textarea
                  id="diff"
                  className="mono"
                  aria-required="true"
                  placeholder="Paste the diff to publish"
                  value={diffRef}
                  onChange={(e) => setDiffRef(e.target.value)}
                  style={{ minHeight: 132 }}
                />
                <span className="field-hint">
                  Unified diff or the structured file list. Your agent column is still open on the right, so you can
                  copy straight out of it.
                </span>
              </>
            ) : (
              /* Nothing chosen and nothing pasted is a designed state, not a
                 blank textarea sitting there demanding work. */
              <div className="changes-empty">
                <p>
                  No change attached yet. Pick one of your agent’s drafts above and this fills itself in, or paste a
                  diff if the work came from somewhere else.
                </p>
                <div className="ce-foot">
                  <button className="btn-secondary" type="button" onClick={goToPaste}>
                    Paste a diff
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="field-pair">
            <div className="field">
              <label htmlFor="baseRef">
                Base branch <Required />
              </label>
              <input
                id="baseRef"
                className="mono"
                aria-required="true"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
              />
              <span className="field-hint">The branch this change is proposed against.</span>
            </div>
            <div className="field">
              <label htmlFor="headCommit">Head commit</label>
              {headCommitManual ? (
                <input
                  id="headCommit"
                  className="mono"
                  value={headCommit}
                  onChange={(e) => setHeadCommit(e.target.value)}
                />
              ) : (
                <div className="derived-value mono" id="headCommit">
                  {PENDING_HEAD_COMMIT}
                </div>
              )}
              <span className="field-hint">
                {headCommitManual ? (
                  <>
                    Set by hand.{' '}
                    <button className="link-btn" type="button" onClick={() => setHeadCommitManual(false)}>
                      Use the derived value
                    </button>
                  </>
                ) : (
                  <>
                    GitHub assigns this when the pull request opens.{' '}
                    <button className="link-btn" type="button" onClick={() => setHeadCommitManual(true)}>
                      Set manually
                    </button>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="field">
            <label id="promote-note-label">Remix note</label>
            {skipRemixNote ? (
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setSkipRemixNote(false)}
                style={{ alignSelf: 'flex-start' }}
              >
                Add a remix note (optional)
              </button>
            ) : (
              <div className="bullets">
                {bullets.map((bullet, index) => (
                  <div className="bullet-row" key={index}>
                    <input
                      aria-labelledby="promote-note-label"
                      value={bullet}
                      placeholder={`Decision, constraint, risk, or dead end #${index + 1}`}
                      onChange={(e) => updateBullet(index, e.target.value)}
                    />
                    <button
                      className="bullet-remove"
                      type="button"
                      onClick={() => removeBullet(index)}
                      disabled={bullets.length <= MIN_BULLETS}
                      aria-label="Remove bullet"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                ))}
                <div className="bullet-tools">
                  <button className="btn-secondary" type="button" onClick={addBullet} disabled={bullets.length >= MAX_BULLETS}>
                    Add bullet
                  </button>
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => {
                      setSkipRemixNote(true);
                      setBullets(Array(MIN_BULLETS).fill(''));
                    }}
                  >
                    Skip instead
                  </button>
                </div>
                <span className="field-hint">Up to {MAX_BULLETS}.</span>
              </div>
            )}
          </div>

          {/* ---- credit ----
              The one thing on this sheet that decides whether a remix is
              recorded as a remix. It is never silent: with no forks it says
              so, and with forks it names the one it will credit. */}
          <section className="promote-parent" aria-labelledby="promote-parent-head">
            <div className="pp-head" id="promote-parent-head">
              <span className="h">Credited against</span>
              <span className="spacer" />
              <span className="n">{chosenParent ? '1 parent' : 'no parent'}</span>
            </div>

            {forkParents.length === 0 ? (
              <p className="pp-empty">
                You have not forked anything in this room, so there is nothing for this promote to build on. It is
                recorded as original work, with no parent in the credit chain.
              </p>
            ) : (
              <>
                <p className="pp-why">
                  Forking is what puts you in someone&rsquo;s credit chain, so this promote is credited against the fork
                  you hold. Your most recent one is picked for you; change it if you were working from a different one.
                </p>
                <div className="pp-list" role="radiogroup" aria-labelledby="promote-parent-head">
                  {forkParents.map((option) => {
                    const picked = option.proposalId === parentProposalId;
                    return (
                      <button
                        className="pp-opt"
                        type="button"
                        key={option.proposalId}
                        role="radio"
                        aria-checked={picked}
                        onClick={() => setParentProposalId(option.proposalId)}
                      >
                        <span className="pp-mark" aria-hidden="true" />
                        <span className="pp-txt">
                          <span className="pp-t">{option.intentSummary}</span>
                          <span className="pp-m">
                            {option.authorName} · you forked it {agoLabel(option.forkedAt)} ·{' '}
                            <span className="mono">{option.headCommit.slice(0, 7)}</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    className="pp-opt"
                    type="button"
                    role="radio"
                    aria-checked={parentProposalId === null}
                    onClick={() => setParentProposalId(null)}
                  >
                    <span className="pp-mark" aria-hidden="true" />
                    <span className="pp-txt">
                      <span className="pp-t">No parent</span>
                      <span className="pp-m">
                        This is my own work and does not build on a fork. Nothing is credited to anyone else.
                      </span>
                    </span>
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="promote-preview" aria-live="polite">
            <h3>Promote preview</h3>
            <p className={intentSummary.trim() ? 'echo' : 'echo unset'}>
              {intentSummary.trim() || 'Intent not set yet.'}
            </p>
            <p className="echo-credit">
              {chosenParent
                ? `Credited as a remix of ${chosenParent.authorName}’s “${chosenParent.intentSummary}”.`
                : 'Credited to you alone, with no parent.'}
            </p>
            {scan.clean ? (
              <span className="scan-clean">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="12" height="12">
                  <path d="M2.5 8.5l3.5 3.5 7.5-8" />
                </svg>
                Secret scan clean
              </span>
            ) : (
              <div className="scan-dirty">
                <span>
                  <strong>Promote blocked by the secret scan.</strong> This is not a missing field: the change carries{' '}
                  {scan.findings.length} value{scan.findings.length === 1 ? '' : 's'} that must not leave your workbench.
                </span>
                <span className="found">
                  {scan.findings.map((f, i) => (
                    <span key={i} className="code-inline">
                      {f.pattern}
                    </span>
                  ))}
                </span>
                <span className="where">Remove them from the changes or the remix note, then promote.</span>
              </div>
            )}
          </section>

          {submit.status === 'error' && <div className="scan-dirty">{submit.message}</div>}

          {/* Why the button is off. Only shown when the scan is clean, so the
              two blocking reasons never compete for the same line. */}
          {scan.clean && missing.length > 0 && (
            <div className="blocked-hint" id="promote-blocked">
              Still needed before you can promote: {missing.join(', ')}.
            </div>
          )}

          <p className="fine">
            Promoting pushes a branch and opens the pull request. The diff and the note are scanned first; nothing is
            published and then redacted.
          </p>
        </div>

        {confirmDiscard ? (
          <div className="sheet-foot discard">
            <div className="discard-guard">
              <span>Discard this promote? The changes in this form are not saved anywhere.</span>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn-secondary" type="button" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </button>
                <button className="btn-danger" type="button" onClick={onClose}>
                  Discard
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="sheet-foot">
            <button className="btn-quiet" type="button" onClick={requestClose}>
              Cancel
            </button>
            <span className="spacer" />
            <button
              className="btn-primary"
              type="button"
              onClick={handlePublish}
              disabled={!canPublish}
              aria-describedby={scan.clean && missing.length > 0 ? 'promote-blocked' : undefined}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
              {submit.status === 'submitting' ? 'Promoting…' : 'Promote to room'}
            </button>
          </div>
        )}
      </div>
    </>,
    container,
  );
}
