'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Polls the server component tree so messages and proposals posted by
// anyone else (including via a direct API call) show up in the feed
// without a manual reload. Interval is short enough to feel live without
// hammering the dev database.
const POLL_MS = 3000;

export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      // A refresh re-renders the server tree, and a card whose state changed
      // takes its client subtree with it. Forking from the feed does exactly
      // that: the new fork makes the card the room's live fork, the card
      // swaps its controls, and the fork sheet the user is reading is torn
      // out from under them a poll later. So the poll yields while any modal
      // is open, and resumes the moment it closes.
      // The promote sheet is anchored rather than centered, so it carries
      // its own scrim class instead of .modal-overlay; both count.
      if (document.querySelector('.modal-overlay, .promote-sheet')) return;
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
