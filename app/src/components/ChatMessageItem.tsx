import { avatarClass, initials, relativeTime } from '@/lib/ui';

export interface ChatMessageData {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  grouped?: boolean;
}

// screen-room.html draws chat as talk on the room's chronological axis:
// a small hollow node on the spine, an avatar + name + time header once
// per consecutive run, and the body indented to the text column beneath
// it. There is no bubble in the comp and no separate treatment for the
// reader's own messages, so `isOwn` no longer changes the rendering.
export function ChatMessageItem({ authorId, authorName, body, createdAt, isOwn, grouped }: ChatMessageData) {
  return (
    <div className={`chat-msg${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}`}>
      <span className="node" aria-hidden="true" />
      {!grouped && (
        <div className="chat-head">
          <span className={`avatar ${avatarClass(authorId)}`}>{initials(authorName)}</span>
          <span className="who">{authorName}</span>
          <span className="timestamp">{relativeTime(createdAt)}</span>
        </div>
      )}
      <p className="chat-text">{body}</p>
    </div>
  );
}
