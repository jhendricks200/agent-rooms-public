'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  RAIL_DRAWER_QUERY,
  getDrawerClosedServer,
  getMediaServer,
  getMediaSnapshot,
  getRailDrawerOpen,
  setRailDrawerOpen,
  subscribeMedia,
  subscribeShell,
} from '@/lib/shellDrawers';

const subscribeNarrow = subscribeMedia(RAIL_DRAWER_QUERY);
const getNarrow = getMediaSnapshot(RAIL_DRAWER_QUERY);

// Below 620px the rail is an overlay drawer rather than a column. Without
// this trigger the rail was simply display:none, which took room
// switching, Members, the brand link home and Sign out with it: the app
// became a read-only log of one room you could not leave.
export function RailToggle() {
  const open = useSyncExternalStore(subscribeShell, getRailDrawerOpen, getDrawerClosedServer);
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getMediaServer);

  useEffect(() => {
    if (!narrow) setRailDrawerOpen(false);
  }, [narrow]);

  return (
    <button
      className="rail-toggle"
      type="button"
      onClick={() => setRailDrawerOpen(!getRailDrawerOpen())}
      aria-expanded={open}
      aria-controls="app-rail"
      aria-label={open ? 'Close rooms menu' : 'Open rooms menu'}
      title={open ? 'Close rooms menu' : 'Open rooms menu'}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}
