'use client';

import { useEffect, useRef, useState } from 'react';

// The room feed opens scrolled to the newest item and stays pinned to the
// bottom while the user is near it. If the user has scrolled up to read
// history, new items do not yank them down - instead a "jump to latest"
// pill appears. Composer.tsx dispatches `agent-rooms:own-message-sent` on
// the window the instant it renders an optimistic message, so a message
// the user just sent always scrolls to bottom regardless of current
// scroll position.

const NEAR_BOTTOM_PX = 96;
const OWN_MESSAGE_EVENT = 'agent-rooms:own-message-sent';

export function FeedScroll({ children, itemCount }: { children: React.ReactNode; itemCount: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(itemCount);
  const ownMessageRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  // Open already scrolled to the newest item, no animation.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    function handleOwnMessage() {
      ownMessageRef.current = true;
      // The optimistic bubble is portalled into the stream, so itemCount
      // does not change and the effect below will not fire for it. Scroll
      // on the next frame, once React has committed the new node.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        atBottomRef.current = true;
        setShowJump(false);
      });
    }
    window.addEventListener(OWN_MESSAGE_EVENT, handleOwnMessage);
    return () => window.removeEventListener(OWN_MESSAGE_EVENT, handleOwnMessage);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const grew = itemCount > prevCountRef.current;
    prevCountRef.current = itemCount;
    if (!el || !grew) return;

    if (ownMessageRef.current || atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setShowJump(false);
    } else {
      setShowJump(true);
    }
    ownMessageRef.current = false;
  }, [itemCount]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
    if (atBottomRef.current) setShowJump(false);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJump(false);
  }

  return (
    <div className="feed-scroll-wrap">
      <div className="feed-scroll" ref={scrollRef} onScroll={handleScroll}>
        {children}
      </div>
      {showJump && (
        <button className="jump-latest-pill" type="button" onClick={jumpToLatest}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M8 3v9M4 8.5 8 12l4-3.5" />
          </svg>
          Jump to latest
        </button>
      )}
    </div>
  );
}
