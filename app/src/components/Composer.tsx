'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PromoteModal, type PromoteParentOption } from './PromoteModal';
import { clearSentOutbox, enqueueOutbox, patchOutbox, resetOutbox } from '@/lib/outbox';

export interface ComposerProps {
  roomId: string;
  roomName: string;
  signedIn: boolean;
  /** Named in the sheet header, so the crossing says where it lands. */
  githubRepoRef?: string;
  /** This reader's forks in this room, most recent first; the promote sheet
   *  credits the promote against one of them. */
  parentOptions?: PromoteParentOption[];
}

export function Composer({ roomId, roomName, signedIn, githubRepoRef, parentOptions }: ComposerProps) {
  const [value, setValue] = useState('');
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Anything still queued belongs to the room it was typed in.
  useEffect(() => resetOutbox, [roomId]);

  // A confirmed message stays on screen until the refreshed feed actually
  // contains it, otherwise the optimistic bubble blinks out and back in as
  // the server tree lands. OutboxMessages renders from an external store,
  // so this is a write to that store rather than a setState cascade.
  useEffect(() => {
    if (!refreshing) clearSentOutbox();
  }, [refreshing]);

  const post = useCallback(
    async (key: string, body: string) => {
      patchOutbox(key, { status: 'sending', error: undefined });
      // The feed always scrolls to bottom for a message the user just sent,
      // even if they had scrolled up to read history.
      window.dispatchEvent(new Event('agent-rooms:own-message-sent'));

      try {
        const res = await fetch(`/api/rooms/${roomId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });

        if (res.ok) {
          patchOutbox(key, { status: 'sent' });
          startRefresh(() => router.refresh());
          return;
        }

        const data: { message?: string; error?: string } = await res.json().catch(() => ({}));
        patchOutbox(key, {
          status: 'failed',
          error: data.message ?? data.error ?? `The room rejected this message (${res.status})`,
        });
      } catch {
        patchOutbox(key, { status: 'failed', error: 'Network error sending to the room' });
      }
    },
    [roomId, router],
  );

  function send() {
    const body = value.trim();
    if (!body || !signedIn) return;
    const key = `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Clear the input and show the message immediately. The send is
    // optimistic; a failure below keeps the text on screen with a retry.
    setValue('');
    enqueueOutbox({ key, body, status: 'sending', retry: () => void post(key, body) });
    void post(key, body);
    inputRef.current?.focus();
  }

  return (
    <>
      <div className="room-composer">
        <div className="rc-box">
          {/* No attachment path exists anywhere in the app, so no attachment
              button: a control inside an input row reads as an action, and a
              dead action invites repeated taps. The rail carries the roadmap;
              the composer carries only what works. */}
          <input
            ref={inputRef}
            type="text"
            placeholder={signedIn ? `Message #${roomName}` : 'Sign in with GitHub to post'}
            value={value}
            disabled={!signedIn}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="rc-cluster">
            {/* One name for the gesture, everywhere: promote. This chip is
                the manual fallback; the primary path is the Promote button
                on the agent's own output in the right-hand pane. */}
            <button
              className="rc-chip"
              type="button"
              title="Promote a change into this room by hand. Your agent's drafts carry their own Promote button."
              disabled={!signedIn}
              onClick={() => setPromoteOpen(true)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 13V3M4 7l4-4 4 4" />
              </svg>
              Promote
            </button>
            <button
              className="rc-send"
              aria-label="Send message"
              type="button"
              onClick={send}
              disabled={!value.trim() || !signedIn}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {promoteOpen && (
        <PromoteModal
          roomId={roomId}
          source="manual"
          githubRepoRef={githubRepoRef}
          parentOptions={parentOptions}
          onClose={() => setPromoteOpen(false)}
          onPromoted={() => {
            setPromoteOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
