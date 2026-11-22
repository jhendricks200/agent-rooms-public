'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AGENT_W_DEFAULT,
  AGENT_W_MAX,
  AGENT_W_MIN,
  AGENT_W_SNAP,
  getAgentWidth,
  getAgentWidthServer,
  setAgentWidth,
  subscribeAgentPane,
} from '@/lib/agentPane';

/** Arrow-key step, and the coarser step Shift adds. */
const STEP = 8;
const STEP_SHIFT = 32;

// The drag handle on the left edge of the agent column. The width itself is
// applied straight to the root element as --agent-col-w (see globals.css
// .app), so a drag never re-renders the room; the subscription here only
// keeps the ARIA value honest. Collapsing is a separate control in the room
// header - a drag clamps at 300px and can never reach zero.
export function AgentPaneResizer() {
  const width = useSyncExternalStore(subscribeAgentPane, getAgentWidth, getAgentWidthServer);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // The move and up listeners go on the window rather than the handle, so a
  // fast drag that outruns the 8px hit area still tracks.
  useEffect(() => {
    if (!dragging) return;
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // The handle sits on the left edge of a right-hand column, so dragging
      // left (a negative delta) makes the column wider.
      setAgentWidth(drag.startWidth - (event.clientX - drag.startX), false, true);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
      document.body.classList.remove('is-col-resizing');
      setAgentWidth(getAgentWidth(), true);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Capture the pointer so the drag keeps tracking once the cursor
    // leaves the handle, including over iframes and other columns.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the window listeners below still carry it.
    }
    const pane = event.currentTarget.parentElement;
    dragRef.current = {
      startX: event.clientX,
      startWidth: pane ? pane.getBoundingClientRect().width : width,
    };
    setDragging(true);
    document.body.classList.add('is-col-resizing');
    event.preventDefault();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? STEP_SHIFT : STEP;
    if (event.key === 'ArrowLeft') {
      setAgentWidth(getAgentWidth() + step, true);
    } else if (event.key === 'ArrowRight') {
      setAgentWidth(getAgentWidth() - step, true);
    } else if (event.key === 'Home') {
      setAgentWidth(AGENT_W_DEFAULT, true);
    } else {
      return;
    }
    event.preventDefault();
  }

  return (
    <div
      className="agent-resizer"
      data-dragging={dragging ? 'true' : 'false'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize agent panel. Arrow keys resize, Home resets."
      aria-valuenow={width}
      aria-valuemin={AGENT_W_MIN}
      aria-valuemax={AGENT_W_MAX}
      tabIndex={0}
      title={`Drag to resize the agent panel (snaps at ${AGENT_W_SNAP}px). Double-click to reset.`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setAgentWidth(AGENT_W_DEFAULT, true)}
    >
      <span className="agent-resizer-line" aria-hidden="true" />
    </div>
  );
}
