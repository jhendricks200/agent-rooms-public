'use client';

import { useEffect, useRef, useState } from 'react';
import { PromoteModal, type PromoteParentOption } from './PromoteModal';
import { AgentDraftCard } from './AgentDraftCard';
import { draftProse, parseAgentDraft, type DraftFile } from '@/lib/agentDraft';

export interface AgentComposerInputProps {
  roomId: string;
  githubRepoRef?: string;
  /** This reader's forks in this room, most recent first. */
  parentOptions?: PromoteParentOption[];
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  workedForMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  servedProvider?: string | null;
  offPolicy?: boolean;
  pending?: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderAgentContent(content: string) {
  // Renders fenced code blocks as preformatted code, plain text otherwise.
  // Keeps parity with the comp's mostly-plain-text agent bubbles. When a
  // promotable draft is present the caller strips the fence entirely and
  // lets the "Ready to promote" card stand in for it, so this path is for
  // replies that carry code but nothing to promote.
  const parts = content.split(/(```[a-zA-Z0-9_-]*\n[\s\S]*?```)/g);
  return parts.map((part, i) => {
    const match = part.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)```$/);
    if (match) {
      return (
        <pre key={i} className="code-inline" style={{ display: 'block', whiteSpace: 'pre-wrap', padding: '8px 10px', margin: '6px 0' }}>
          {match[1].trim()}
        </pre>
      );
    }
    if (!part.trim()) return null;
    return (
      <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
        {part}
      </p>
    );
  });
}

export function AgentComposerInput({ roomId, githubRepoRef, parentOptions }: AgentComposerInputProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [promoteDraft, setPromoteDraft] = useState<{
    intentSummary: string;
    diffRef: string;
    bullets: string[];
    files: DraftFile[];
  } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agent/message?roomId=${encodeURIComponent(roomId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.messages)) return;
        setMessages(
          data.messages
            .filter((m: { role: string }) => m.role !== 'system')
            .map(
              (m: {
                id: string;
                role: string;
                content: string;
                tokensIn: number;
                tokensOut: number;
                servedProvider?: string | null;
                offPolicy?: boolean;
              }) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                tokensIn: m.tokensIn,
                tokensOut: m.tokensOut,
                servedProvider: m.servedProvider,
                offPolicy: m.offPolicy,
              }),
            ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setErrorDetail(null);
    setValue('');

    const userId = `local-user-${Date.now()}`;
    const userMsg: DisplayMessage = { id: userId, role: 'user', content: body };
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', content: '', pending: true }]);

    const startedAt = Date.now();

    // A turn that produced no reply did not happen. The route rolls the
    // persisted user row back, so the optimistic echo goes too and the text
    // returns to the composer for a retry — the same shape as a failed room
    // send (see Composer.tsx). Leaving the echo up was what let a retry
    // render the prompt twice.
    function failTurn(message: string, detail?: string | null) {
      setError(message);
      setErrorDetail(detail ?? null);
      setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== userId));
      setValue((current) => (current.trim() ? current : body));
    }

    try {
      const res = await fetch('/api/agent/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, content: body }),
      });

      if (!res.ok || !res.body) {
        // Refusals raised before the model is ever called — the maintainer
        // kill switch, and the daily / room / per-user token budgets — come
        // back as JSON with their own human copy, and never persisted a user
        // message in the first place.
        const data = await res.json().catch(() => ({}));
        failTurn(data.message ?? data.error ?? `Your agent could not take this turn (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: {
            type: string;
            delta?: string;
            tokensIn?: number;
            tokensOut?: number;
            elapsedMs?: number;
            message?: string;
            detail?: string;
            provider?: string | null;
            offPolicy?: boolean;
          };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          if (parsed.type === 'token' && parsed.delta) {
            text += parsed.delta;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: text } : m)));
          } else if (parsed.type === 'done') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: text,
                      pending: false,
                      tokensIn: parsed.tokensIn,
                      tokensOut: parsed.tokensOut,
                      workedForMs: parsed.elapsedMs ?? Date.now() - startedAt,
                      servedProvider: parsed.provider,
                      offPolicy: parsed.offPolicy,
                    }
                  : m,
              ),
            );
          } else if (parsed.type === 'error') {
            failTurn(
              parsed.message ?? 'Something went wrong while your agent was answering. Try again.',
              parsed.detail,
            );
          }
        }
      }
    } catch (err) {
      failTurn(
        'Could not reach your agent. Check your connection — your prompt is back in the composer.',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="agent-chat" ref={chatRef}>
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="msg user" key={m.id}>
              {m.content}
            </div>
          ) : (
            <div className="msg agent" key={m.id}>
              {(m.workedForMs !== undefined || m.pending) && (
                <div className="worked">
                  {m.pending
                    ? 'working…'
                    : `worked ${formatElapsed(m.workedForMs ?? 0)} · ${(m.tokensIn ?? 0) + (m.tokensOut ?? 0)} tokens${
                        m.servedProvider ? ` · via ${m.servedProvider}` : ''
                      }`}
                  {!m.pending && m.offPolicy && (
                    <span style={{ color: 'var(--rose)' }}> · off-policy provider, review routing config</span>
                  )}
                </div>
              )}
              {(() => {
                // The promote affordance belongs on the output itself. A
                // finished reply that parses as a draft renders its prose
                // plus the "Ready to promote" card (design/screen-room.html),
                // with the raw artifact folded into the card rather than
                // dumped as a wall of JSON above it.
                const draft = m.pending ? null : parseAgentDraft(m.content);
                if (!draft) {
                  return renderAgentContent(m.content || (m.pending ? '' : '(empty reply)'));
                }
                return (
                  <>
                    {renderAgentContent(draftProse(m.content))}
                    <AgentDraftCard
                      intentSummary={draft.intentSummary}
                      files={draft.files}
                      githubRepoRef={githubRepoRef}
                      onPromote={() =>
                        setPromoteDraft({
                          intentSummary: draft.intentSummary,
                          diffRef: draft.diffRef,
                          bullets: draft.bullets,
                          files: draft.files,
                        })
                      }
                    />
                  </>
                );
              })()}
            </div>
          ),
        )}
        {error && (
          <div className="msg agent failed">
            {error}
            {errorDetail && (
              // The provider's raw body is what a maintainer needs and what
              // a room member does not. Folded shut by default; the server
              // log has the same string regardless of whether anyone opens
              // this.
              <details className="agent-error-detail">
                <summary>Technical detail</summary>
                <pre className="code-inline">{errorDetail}</pre>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="agent-composer">
        <div className="composer-box">
          <textarea
            placeholder="Ask your agent"
            value={value}
            disabled={sending}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            {/* No add-context button until add-context exists: a dead control
                in an input row invites taps the app cannot honor. */}
            <span className="model">gpt-5.6-luna · US</span>
            <div className="spacer" />
            <button className="send-btn" aria-label="Send" type="button" onClick={send} disabled={sending || !value.trim()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {promoteDraft && (
        <PromoteModal
          roomId={roomId}
          source="agent"
          githubRepoRef={githubRepoRef}
          parentOptions={parentOptions}
          initialIntentSummary={promoteDraft.intentSummary}
          initialDiffRef={promoteDraft.diffRef}
          initialBullets={promoteDraft.bullets}
          initialFiles={promoteDraft.files}
          onClose={() => setPromoteDraft(null)}
          onPromoted={() => setPromoteDraft(null)}
        />
      )}
    </>
  );
}
