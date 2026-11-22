'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import {
  closeAllDrawers,
  getAgentDrawerOpen,
  getDrawerClosedServer,
  getRailDrawerOpen,
  subscribeShell,
} from '@/lib/shellDrawers';

// The dimmed backdrop behind either overlay drawer. Clicking it or
// pressing Escape closes whatever is open, so a drawer is never a trap.
export function DrawerScrim() {
  const agentOpen = useSyncExternalStore(subscribeShell, getAgentDrawerOpen, getDrawerClosedServer);
  const railOpen = useSyncExternalStore(subscribeShell, getRailDrawerOpen, getDrawerClosedServer);
  const open = agentOpen || railOpen;
  const pathname = usePathname();

  // Switching rooms from inside the rail drawer should land you in the new
  // room, not behind the drawer you just used.
  useEffect(() => {
    closeAllDrawers();
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeAllDrawers();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;
  return <div className="drawer-scrim" onClick={closeAllDrawers} aria-hidden="true" />;
}
