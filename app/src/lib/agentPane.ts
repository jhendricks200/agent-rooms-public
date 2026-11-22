// Shared constants and storage helpers for the resizable agent column.
// The width and the collapsed flag live on the root element (a CSS custom
// property and a data attribute) so the pre-paint script in the root layout
// can restore both before first paint, the same way the theme is restored.

export const AGENT_W_DEFAULT = 316;
export const AGENT_W_MIN = 300;
export const AGENT_W_MAX = 560;
/** Widths within this many pixels of the default snap back to it. */
export const AGENT_W_SNAP_RANGE = 12;
export const AGENT_W_SNAP = AGENT_W_DEFAULT;

export const AGENT_W_KEY = 'signal-lab-agent-width';
export const AGENT_COLLAPSED_KEY = 'signal-lab-agent-collapsed';

export function clampAgentWidth(width: number): number {
  return Math.min(AGENT_W_MAX, Math.max(AGENT_W_MIN, Math.round(width)));
}

/** Drag-only: snapping a keyboard step would trap it inside the snap zone. */
export function snapAgentWidth(width: number): number {
  const bounded = clampAgentWidth(width);
  return Math.abs(bounded - AGENT_W_DEFAULT) <= AGENT_W_SNAP_RANGE ? AGENT_W_DEFAULT : bounded;
}

export function applyAgentWidth(width: number): void {
  document.documentElement.style.setProperty('--agent-col-w', `${width}px`);
}

export function readStoredAgentWidth(): number {
  try {
    const raw = localStorage.getItem(AGENT_W_KEY);
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return clampAgentWidth(parsed);
    }
  } catch {
    // localStorage unavailable; fall back to the default width.
  }
  return AGENT_W_DEFAULT;
}

export function storeAgentWidth(width: number): void {
  try {
    localStorage.setItem(AGENT_W_KEY, String(width));
  } catch {
    // Width just will not persist across reloads.
  }
}

export function readStoredAgentCollapsed(): boolean {
  try {
    return localStorage.getItem(AGENT_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function applyAgentCollapsed(collapsed: boolean): void {
  const root = document.documentElement;
  if (collapsed) root.setAttribute('data-agent-collapsed', 'true');
  else root.removeAttribute('data-agent-collapsed');
  try {
    localStorage.setItem(AGENT_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Collapsed state just will not persist across reloads.
  }
}

/* ---- external store ----
   The width and the collapsed flag are browser state that the pre-paint
   script already owns before React exists, so the components read them with
   useSyncExternalStore rather than copying them into state inside an effect.
   The server snapshot is the design default, which is what the markup is
   rendered against. */

type Listener = () => void;
const listeners = new Set<Listener>();
let widthSnapshot: number | null = null;
let collapsedSnapshot: boolean | null = null;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeAgentPane(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentWidth(): number {
  if (widthSnapshot === null) widthSnapshot = readStoredAgentWidth();
  return widthSnapshot;
}

export function getAgentWidthServer(): number {
  return AGENT_W_DEFAULT;
}

export function setAgentWidth(width: number, persist: boolean, snap = false): void {
  const next = snap ? snapAgentWidth(width) : clampAgentWidth(width);
  applyAgentWidth(next);
  if (persist) storeAgentWidth(next);
  if (next === widthSnapshot) return;
  widthSnapshot = next;
  emit();
}

export function getAgentCollapsed(): boolean {
  if (collapsedSnapshot === null) collapsedSnapshot = readStoredAgentCollapsed();
  return collapsedSnapshot;
}

export function getAgentCollapsedServer(): boolean {
  return false;
}

export function setAgentCollapsed(collapsed: boolean): void {
  applyAgentCollapsed(collapsed);
  if (collapsed === collapsedSnapshot) return;
  collapsedSnapshot = collapsed;
  emit();
}
