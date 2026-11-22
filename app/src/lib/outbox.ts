// The room composer's outbox: messages the user has sent that the server
// has not confirmed yet, plus the ones whose send failed.
//
// It is an external store rather than component state because the two
// halves live in different parts of the server-rendered tree: the
// composer sits below the feed's scroll container, while the optimistic
// bubbles have to appear at the bottom of the feed stream itself. Same
// pattern as src/lib/agentPane.ts.

export type OutboxStatus = 'sending' | 'sent' | 'failed';

export interface OutboxMessage {
  key: string;
  body: string;
  status: OutboxStatus;
  error?: string;
  /** Re-runs the send. Supplied by the composer, which owns the request. */
  retry: () => void;
}

type Listener = () => void;
const listeners = new Set<Listener>();

const EMPTY: OutboxMessage[] = [];
let items: OutboxMessage[] = EMPTY;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOutbox(): OutboxMessage[] {
  return items;
}

/** Server snapshot: nothing is in flight during the server render. */
export function getOutboxServer(): OutboxMessage[] {
  return EMPTY;
}

export function enqueueOutbox(message: OutboxMessage): void {
  items = [...items, message];
  emit();
}

export function patchOutbox(key: string, patch: Partial<Omit<OutboxMessage, 'key'>>): void {
  if (!items.some((m) => m.key === key)) return;
  items = items.map((m) => (m.key === key ? { ...m, ...patch } : m));
  emit();
}

export function removeOutbox(key: string): void {
  if (!items.some((m) => m.key === key)) return;
  items = items.filter((m) => m.key !== key);
  emit();
}

/** Drops confirmed messages once the refreshed feed actually contains them. */
export function clearSentOutbox(): void {
  if (!items.some((m) => m.status === 'sent')) return;
  items = items.filter((m) => m.status !== 'sent');
  emit();
}

/** Leaving the room drops anything still queued for it. */
export function resetOutbox(): void {
  if (items.length === 0) return;
  items = EMPTY;
  emit();
}
