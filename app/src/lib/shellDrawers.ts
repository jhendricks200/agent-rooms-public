// Overlay drawers for the two columns the narrow layouts used to simply
// delete. Below 1180px the agent column becomes a right-hand drawer;
// below 620px the left rail becomes a left-hand drawer. Both are driven
// by an attribute on the root element, the same mechanism the theme and
// the agent column's collapsed flag already use, so the CSS owns the
// presentation and React only owns the boolean.
//
// Deliberately not persisted: a drawer is a transient overlay over the
// content you are reading, not a layout preference.

export const AGENT_DRAWER_QUERY = '(max-width: 1180px)';
export const RAIL_DRAWER_QUERY = '(max-width: 620px)';

const AGENT_DRAWER_ATTR = 'data-agent-drawer';
const RAIL_DRAWER_ATTR = 'data-rail-drawer';

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeShell(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let agentDrawerOpen = false;
let railDrawerOpen = false;

function applyDrawer(attr: string, open: boolean) {
  const root = document.documentElement;
  if (open) root.setAttribute(attr, 'open');
  else root.removeAttribute(attr);
}

export function getAgentDrawerOpen(): boolean {
  return agentDrawerOpen;
}
export function getRailDrawerOpen(): boolean {
  return railDrawerOpen;
}
/** Server snapshot: both drawers start closed, which is what the markup renders. */
export const getDrawerClosedServer = () => false;

export function setAgentDrawerOpen(open: boolean): void {
  applyDrawer(AGENT_DRAWER_ATTR, open);
  if (open === agentDrawerOpen) return;
  agentDrawerOpen = open;
  emit();
}

export function setRailDrawerOpen(open: boolean): void {
  applyDrawer(RAIL_DRAWER_ATTR, open);
  if (open === railDrawerOpen) return;
  railDrawerOpen = open;
  emit();
}

export function closeAllDrawers(): void {
  setAgentDrawerOpen(false);
  setRailDrawerOpen(false);
}

/* ---- media query as an external store ----
   The agent toggle has to know whether it is collapsing a column or
   opening a drawer, so the breakpoint is read in JS as well as in CSS.
   The query strings are exported above so the two can never drift. */

export function subscribeMedia(query: string) {
  return (listener: Listener) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', listener);
    // `resize` as well as `change`: some embedded and remote-controlled
    // browsers resize the viewport without dispatching a MediaQueryList
    // change event, and a toggle that thinks it is still on the desktop
    // side of the breakpoint collapses a column that is not there.
    window.addEventListener('resize', listener);
    return () => {
      mql.removeEventListener('change', listener);
      window.removeEventListener('resize', listener);
    };
  };
}

/**
 * Read live rather than from a cached snapshot. The value is a boolean, so
 * there is no referential-identity problem for useSyncExternalStore, and a
 * cache that misses an update is worse than a matchMedia call per render.
 */
export function getMediaSnapshot(query: string) {
  return () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
}

export const getMediaServer = () => false;
