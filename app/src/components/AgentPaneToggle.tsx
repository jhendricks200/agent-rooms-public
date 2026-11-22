'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getAgentCollapsed,
  getAgentCollapsedServer,
  setAgentCollapsed,
  subscribeAgentPane,
} from '@/lib/agentPane';
import {
  AGENT_DRAWER_QUERY,
  getAgentDrawerOpen,
  getDrawerClosedServer,
  getMediaServer,
  getMediaSnapshot,
  setAgentDrawerOpen,
  subscribeMedia,
  subscribeShell,
} from '@/lib/shellDrawers';

const noopSubscribe = () => () => {};
const isMacClient = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isMacServer = () => false;

const subscribeNarrow = subscribeMedia(AGENT_DRAWER_QUERY);
const getNarrow = getMediaSnapshot(AGENT_DRAWER_QUERY);

// Collapsing the agent column is an explicit control, never a drag to zero.
// It lives in the room header so it stays reachable while the column is
// hidden, and it names its shortcut in the tooltip and the accessible label.
//
// Below 1180px the agent panel is not a column at all - it is an overlay
// drawer - and this same button opens and closes it. The control that
// reveals the panel is never itself hidden, at any width: hiding it was
// how a 13" laptop lost the repo link, the build row and the agent.
export function AgentPaneToggle() {
  const collapsed = useSyncExternalStore(subscribeAgentPane, getAgentCollapsed, getAgentCollapsedServer);
  const drawerOpen = useSyncExternalStore(subscribeShell, getAgentDrawerOpen, getDrawerClosedServer);
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getMediaServer);
  const isMac = useSyncExternalStore(noopSubscribe, isMacClient, isMacServer);

  // "Hidden" means two different things either side of the breakpoint:
  // a collapsed column above it, a closed drawer below it. One control.
  const hidden = narrow ? !drawerOpen : collapsed;

  const toggle = useCallback(() => {
    if (getNarrow()) setAgentDrawerOpen(!getAgentDrawerOpen());
    else setAgentCollapsed(!getAgentCollapsed());
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  // Growing back past the breakpoint turns the drawer into a column again,
  // so a drawer left open must not linger as an overlay.
  useEffect(() => {
    if (!narrow) setAgentDrawerOpen(false);
  }, [narrow]);

  const shortcut = isMac ? '⌘\\' : 'Ctrl+\\';
  const label = hidden ? 'Show agent panel' : 'Hide agent panel';

  return (
    <button
      className="agent-toggle"
      type="button"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={`${label} (${shortcut})`}
      title={`${label} (${shortcut})`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16" />
      </svg>
      <span className="agent-toggle-key">{shortcut}</span>
    </button>
  );
}
