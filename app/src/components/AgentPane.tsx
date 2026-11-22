import { EnvironmentRail, type BuildStatus } from './EnvironmentRail';
import { AgentComposerInput } from './AgentComposerInput';
import { AgentPaneResizer } from './AgentPaneResizer';
import type { PromoteParentOption } from './PromoteModal';

export interface AgentPaneProps {
  roomId: string;
  githubRepoRef: string;
  buildStatus: BuildStatus;
  checksLabel: string;
  workingAgents: { id: string; displayName: string }[];
  lastAdoptedLabel: string | null;
  currentUserDisplayName: string;
  /** This reader's forks in this room, most recent first. Threaded through
   *  to the promote sheet the agent's own draft opens. */
  parentOptions?: PromoteParentOption[];
}

// The private agent chat is live: it calls the hosted model (see
// src/lib/model.ts and the api/agent/message route) and persists to
// agent_sessions / agent_messages. The environment rail above it is real,
// drawn from the room's linked repo and adoption history.
export function AgentPane({
  roomId,
  githubRepoRef,
  buildStatus,
  checksLabel,
  workingAgents,
  lastAdoptedLabel,
  currentUserDisplayName,
  parentOptions,
}: AgentPaneProps) {
  return (
    <aside className="agent-pane">
      <AgentPaneResizer />
      <EnvironmentRail
        githubRepoRef={githubRepoRef}
        buildStatus={buildStatus}
        checksLabel={checksLabel}
        workingAgents={workingAgents}
        lastAdoptedLabel={lastAdoptedLabel}
      />

      <div className="agent-head">
        <div className="agent-glyph">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M8 10h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" />
            <circle cx="9.5" cy="15" r="0.5" fill="currentColor" />
            <circle cx="14.5" cy="15" r="0.5" fill="currentColor" />
          </svg>
        </div>
        <div className="agent-id">
          <div className="name">Your agent</div>
          <div className="scope">{currentUserDisplayName.toLowerCase().split(' ')[0]} · workbench 03</div>
        </div>
        <span className="private-chip">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" />
          </svg>
          private
        </span>
      </div>

      <AgentComposerInput roomId={roomId} githubRepoRef={githubRepoRef} parentOptions={parentOptions} />
    </aside>
  );
}
