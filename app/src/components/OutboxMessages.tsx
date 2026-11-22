'use client';

import { useSyncExternalStore } from 'react';
import { getOutbox, getOutboxServer, removeOutbox, subscribeOutbox } from '@/lib/outbox';
import { avatarClass, initials } from '@/lib/ui';

export interface OutboxMessagesProps {
  currentUserId: string | null;
  currentUserName: string | null;
}

// Renders at the bottom of the room's feed stream, so a message the user
// just sent appears in the conversation the instant they send it: dimmed
// and marked "sending…" while the POST is in flight, and kept on screen
// in the failure tone with a retry if it never landed. Before this, a
// slow send cleared the input and showed nothing anywhere, and a failed
// send showed nothing but an unhandled rejection in the console.
export function OutboxMessages({ currentUserId, currentUserName }: OutboxMessagesProps) {
  const outbox = useSyncExternalStore(subscribeOutbox, getOutbox, getOutboxServer);
  if (outbox.length === 0) return null;

  const name = currentUserName ?? 'You';

  return (
    <>
      {outbox.map((m) => (
        <div className={`chat-msg outbox ${m.status}`} key={m.key}>
          <span className="node" aria-hidden="true" />
          <div className="chat-head">
            <span className={`avatar ${avatarClass(currentUserId ?? 'you')}`}>{initials(name)}</span>
            <span className="who">{name}</span>
            <span className="timestamp">{m.status === 'failed' ? 'not sent' : 'sending…'}</span>
          </div>
          <p className="chat-text">{m.body}</p>
          {m.status === 'failed' && (
            <div className="chat-failed" role="alert">
              <span className="chat-failed-msg">{m.error ?? 'Could not send this message'}</span>
              <button className="chat-retry" type="button" onClick={m.retry}>
                Retry
              </button>
              <button className="chat-retry ghost" type="button" onClick={() => removeOutbox(m.key)}>
                Discard
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
