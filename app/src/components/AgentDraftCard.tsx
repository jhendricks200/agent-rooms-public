'use client';

import type { DraftFile } from '@/lib/agentDraft';

export interface AgentDraftCardProps {
  intentSummary: string;
  files: DraftFile[];
  githubRepoRef?: string;
  onPromote: () => void;
}

const MAX_LISTED_FILES = 6;

function marker(changeType: DraftFile['changeType']): { glyph: string; className: string } {
  if (changeType === 'add') return { glyph: '+', className: 'add' };
  if (changeType === 'delete') return { glyph: '−', className: 'del' };
  return { glyph: '~', className: 'mod' };
}

/**
 * The promote affordance, on the agent output itself.
 *
 * This is the primary path into promote: the private-to-shared crossing is
 * the product, so the gesture lives on the thing being crossed over rather
 * than only on a composer chip. Treatment follows design/screen-room.html
 * (.out): amber "Ready to promote" lead, the intent as the title, the
 * changed-file list, and a full-width cyan "Promote to room" button. Cyan,
 * not green: green is reserved for adoption and passing builds.
 */
export function AgentDraftCard({ intentSummary, files, githubRepoRef, onPromote }: AgentDraftCardProps) {
  const shown = files.slice(0, MAX_LISTED_FILES);
  const overflow = files.length - shown.length;

  return (
    <div className="output-card" style={{ marginTop: 10 }}>
      <div className="oc-label">
        <span className="dot" aria-hidden="true" />
        Ready to promote
      </div>
      <div className="oc-title">{intentSummary || 'Draft from your agent'}</div>
      <div className="oc-desc">
        {files.length > 0
          ? `${files.length} file${files.length === 1 ? '' : 's'} changed. `
          : 'A change your agent drafted. '}
        Private until you promote{githubRepoRef ? `, then it opens a pull request on ${githubRepoRef}` : ''}.
      </div>
      {shown.length > 0 && (
        <div className="oc-files">
          {shown.map((file, index) => {
            const m = marker(file.changeType);
            return (
              <span className={m.className} key={`${file.path}-${index}`}>
                {m.glyph} {file.path}
              </span>
            );
          })}
          {overflow > 0 && <span>and {overflow} more</span>}
        </div>
      )}
      <button className="promote-btn" type="button" onClick={onPromote}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
        Promote to room
      </button>
    </div>
  );
}
