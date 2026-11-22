import { NextRequest } from 'next/server';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentSessions, agentMessages, rooms, proposals, proposalVersions, forks, contributors } from '@/db/schema';
import { generateId } from '@/lib/ids';
import { getCurrentContributorId } from '@/lib/session';
import { streamChatCompletion, OffPolicyProviderError, ModelRequestError, type ChatMessage } from '@/lib/model';
import {
  estimateRequestTokens,
  reserveUsage,
  reconcileUsage,
  releaseReservation,
  MAX_OUTPUT_TOKENS,
} from '@/lib/budget';

async function getOrCreateSession(ownerContributorId: string, roomId: string) {
  const [existing] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ownerContributorId, ownerContributorId), eq(agentSessions.roomId, roomId)))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(agentSessions)
    .values({ id: generateId('agent_session'), ownerContributorId, roomId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Race: another request created it between select and insert.
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.ownerContributorId, ownerContributorId), eq(agentSessions.roomId, roomId)))
    .limit(1);
  return row;
}

// Exported for tests only (see __tests__/agentMessage.route.test.ts, which
// asserts the fork-bundle query stays scoped to one room even when the same
// contributor has forks in other rooms). Not a route handler; Next.js only
// dispatches the HTTP-verb exports below.
export async function buildSystemPrompt(roomId: string, sessionId: string): Promise<string> {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  const roomProposals = await db.select().from(proposals).where(eq(proposals.roomId, roomId));
  const allContributors = await db.select().from(contributors);
  const contributorName = (id: string) => allContributors.find((c) => c.id === id)?.displayName ?? id;

  const proposalLines = roomProposals
    .map((p) => `- ${p.id} · author ${contributorName(p.authorContributorId)} · state ${p.state}`)
    .join('\n');

  // Fork bundle: any Fork records made by this session's owner, scoped to
  // this room's proposals in the query itself (not fetched unfiltered and
  // then filtered in memory, which cannot grow unbounded as rooms and
  // proposal history grow).
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  let forkBundleText = 'none';
  if (session) {
    const proposalIds = roomProposals.map((p) => p.id);
    const relevantForks = proposalIds.length
      ? await db
          .select()
          .from(forks)
          .where(and(eq(forks.byContributorId, session.ownerContributorId), inArray(forks.proposalId, proposalIds)))
      : [];
    if (relevantForks.length > 0) {
      const versionIds = relevantForks.map((f) => f.proposalVersionId);
      const versions = await db
        .select()
        .from(proposalVersions)
        .where(
          and(
            inArray(proposalVersions.versionId, versionIds),
            eq(proposalVersions.status, 'published'),
          ),
        );
      forkBundleText = relevantForks
        .map((f) => {
          const v = versions.find((pv) => pv.versionId === f.proposalVersionId);
          return `- forked ${f.proposalId} at version ${f.proposalVersionId}: ${v?.intentSummary ?? '(unknown)'}`;
        })
        .join('\n');
    }
  }

  return [
    `You are the private builder's copilot for the room "${room?.name ?? roomId}".`,
    room?.githubRepoRef ? `Linked repo: ${room.githubRepoRef}.` : '',
    'Current proposals in this room:',
    proposalLines || '(none yet)',
    'Fork bundles this user pulled:',
    forkBundleText,
    '',
    'You discuss, plan, and draft privately with this one builder. You never see other builders\' private chats.',
    'When the user asks for something promotable, produce a draft with: an intent summary line starting with',
    '"Intent:", the file changes in a fenced ```json code block shaped exactly like',
    '{"files":[{"path":"src/x.ts","content":"...full new file content...","changeType":"add|modify|delete"}]},',
    'and 1 to 6 remix note bullets in a section starting with "Remix notes:" as a markdown bullet list.',
    'content must be the complete new file text, not a patch fragment. Keep drafts concrete and scoped to',
    'this room\'s stack.',
  ]
    .filter(Boolean)
    .join('\n');
}

// What the user is told when a turn fails, and what a maintainer needs to
// debug it, are two different things. The provider's own body is JSON with
// a provider name and an OpenRouter settings link in it: meaningless to a
// room member, and it was being rendered verbatim in the transcript. So the
// route classifies the failure into one human sentence for the client and
// writes the raw body to the server log only; `detail` never crosses the
// wire, since a provider body can carry account details and internal URLs.
export interface AgentTurnFailure {
  code: string;
  message: string;
  detail: string;
}

export function describeTurnFailure(err: unknown): AgentTurnFailure {
  const detail = err instanceof Error ? err.message : String(err);

  // Off-policy provider: deliberate copy, deliberately unchanged. This is a
  // provenance control, not an outage, and the user is told plainly that a
  // response was discarded rather than shown.
  if (err instanceof OffPolicyProviderError) {
    return { code: 'off_policy_provider', message: err.message, detail };
  }

  if (err instanceof ModelRequestError) {
    if (err.status === 429) {
      return {
        code: 'provider_rate_limited',
        message:
          'The model provider is rate-limiting requests right now. This turn was discarded and your prompt is back in the composer — try sending it again in a moment.',
        detail,
      };
    }
    if (err.status === 401 || err.status === 402 || err.status === 403) {
      return {
        code: 'provider_rejected_credentials',
        message:
          'The hosted agent could not authenticate with the model provider. That is a configuration problem on this room, not something you can retry past — tell the room maintainer.',
        detail,
      };
    }
    if (err.status >= 500) {
      return {
        code: 'provider_unavailable',
        message:
          'The model provider failed to answer this turn. This turn was discarded and your prompt is back in the composer — try again shortly.',
        detail,
      };
    }
    return {
      code: 'provider_error',
      message:
        'The model provider rejected this turn. This turn was discarded and your prompt is back in the composer — try again, and tell the room maintainer if it keeps happening.',
      detail,
    };
  }

  return {
    code: 'agent_turn_failed',
    message:
      'Something went wrong while your agent was answering. This turn was discarded and your prompt is back in the composer — try again, and tell the room maintainer if it keeps happening.',
    detail,
  };
}

// Loads (or lazily creates) the dev user's session for a room and returns
// its message history, so the sidebar can render prior turns on page load.
export async function GET(request: NextRequest) {
  const ownerContributorId = await getCurrentContributorId();
  if (!ownerContributorId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
  }

  const roomId = request.nextUrl.searchParams.get('roomId');
  if (!roomId) {
    return new Response(JSON.stringify({ error: 'roomId is required' }), { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) {
    return new Response(JSON.stringify({ error: 'room not found' }), { status: 404 });
  }

  const session = await getOrCreateSession(ownerContributorId, roomId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'could not create agent session' }), { status: 500 });
  }

  const history = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, session.id))
    .orderBy(agentMessages.createdAt);

  return Response.json({
    sessionId: session.id,
    messages: history.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      servedProvider: m.servedProvider,
      offPolicy: m.offPolicy,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const ownerContributorId = await getCurrentContributorId();
  if (!ownerContributorId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const roomId = body?.roomId;
  const content = body?.content;

  if (typeof roomId !== 'string' || !roomId) {
    return new Response(JSON.stringify({ error: 'roomId is required' }), { status: 400 });
  }
  if (typeof content !== 'string' || !content.trim()) {
    return new Response(JSON.stringify({ error: 'content is required' }), { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) {
    return new Response(JSON.stringify({ error: 'room not found' }), { status: 404 });
  }

  const session = await getOrCreateSession(ownerContributorId, roomId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'could not create agent session' }), { status: 500 });
  }

  // Reservation: sized from the existing history plus the incoming message,
  // admitted (or refused) atomically inside a locked transaction, before the
  // user message is written and before the model is ever called. See
  // lib/budget.ts for the row-lock mechanics that make two concurrent
  // requests unable to both pass a cap.
  const priorHistory = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, session.id))
    .orderBy(agentMessages.createdAt);
  const estimatedTokens = estimateRequestTokens([...priorHistory.map((m) => ({ content: m.content })), { content }]);

  const reservation = await reserveUsage({
    roomId,
    sessionId: session.id,
    contributorId: ownerContributorId,
    estimatedTokens,
  });

  if (reservation.kind === 'room_missing') {
    return new Response(JSON.stringify({ error: 'room not found' }), { status: 404 });
  }
  if (reservation.kind === 'kill_switch') {
    return new Response(
      JSON.stringify({
        error: 'kill_switch_enabled',
        message: 'The hosted agent is currently disabled for this room by a maintainer.',
      }),
      { status: 423 },
    );
  }
  if (reservation.kind === 'daily_cap') {
    return new Response(
      JSON.stringify({
        error: 'daily_cap_exceeded',
        message: `This session has used ${reservation.used} of ${reservation.cap} tokens today. The cap resets at midnight UTC.`,
      }),
      { status: 429 },
    );
  }
  if (reservation.kind === 'room_cap') {
    return new Response(
      JSON.stringify({
        error: 'room_budget_exceeded',
        message: `This room has used ${reservation.used} of its ${reservation.cap} token budget today. The budget resets at midnight UTC.`,
      }),
      { status: 429 },
    );
  }
  if (reservation.kind === 'user_cap') {
    return new Response(
      JSON.stringify({
        error: 'user_budget_exceeded',
        message: `You have used ${reservation.used} of your ${reservation.cap} token budget in this room today. The budget resets at midnight UTC.`,
      }),
      { status: 429 },
    );
  }

  // A plain local, not `reservation` itself: TypeScript's
  // discriminated-union narrowing from the guard clauses above does not
  // cross into the closures below (start/cancel are separate function
  // bodies), so capture the field directly with its own concrete type.
  const reservationId = reservation.reservationId;

  const userMessageId = generateId('agent_message');
  await db.insert(agentMessages).values({
    id: userMessageId,
    sessionId: session.id,
    role: 'user',
    content: content.trim(),
    tokensIn: 0,
    tokensOut: 0,
  });

  const history = [...priorHistory, { role: 'user' as const, content: content.trim() }];

  const systemPrompt = await buildSystemPrompt(roomId, session.id);

  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m): ChatMessage => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  // Settlement is idempotent in lib/budget.ts (the reservation row is
  // locked and must still be pending), so a release racing a reconcile, or
  // either one retried, cannot double-adjust the room counter. No local
  // "settled" flag is needed or trusted.
  async function release() {
    await releaseReservation({ reservationId }).catch(() => {});
  }

  // A turn is an exchange. If the model never produced a reply, the exchange
  // did not happen, and leaving the user's row behind stranded it in the
  // transcript with nothing answering it — which is also what made a retry
  // render the same prompt twice (the stranded row came back from history,
  // the retry added its own copy). Set once the assistant row is actually
  // written, so a failure after that point never deletes real history.
  let assistantPersisted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // max_tokens is the output half of the reservation, so actual
        // usage cannot exceed what admission control reserved.
        const result = await streamChatCompletion(
          chatMessages,
          (delta) => {
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'token', delta }) + '\n'));
          },
          { maxOutputTokens: MAX_OUTPUT_TOKENS },
        );

        const assistantMessageId = generateId('agent_message');
        await db.insert(agentMessages).values({
          id: assistantMessageId,
          sessionId: session.id,
          role: 'assistant',
          content: result.text,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          servedProvider: result.provider,
          offPolicy: false,
        });
        assistantPersisted = true;

        await reconcileUsage({
          reservationId,
          actualTokens: result.tokensIn + result.tokensOut,
        });

        const elapsedMs = Date.now() - startedAt;
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: 'done',
              messageId: assistantMessageId,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              elapsedMs,
              provider: result.provider,
              offPolicy: false,
            }) + '\n',
          ),
        );
      } catch (err) {
        // An off-policy (or unattested) provider aborts the stream in
        // lib/model.ts before the response is complete. Nothing is
        // persisted as a normal assistant message, the reservation is
        // released, and the client is told plainly why.
        await release();

        const failure = describeTurnFailure(err);

        // The maintainer gets everything in the server log: status,
        // provider body, and which session it happened in. The client gets
        // only the code and the human sentence; the raw provider body can
        // carry account details and internal URLs and never leaves the
        // server.
        console.error(
          `[agent] turn failed for session ${session.id} in room ${roomId} (${failure.code}): ${failure.detail}`,
        );

        // Roll the user's message back so a failed turn leaves no half of an
        // exchange behind. Guarded on assistantPersisted so a failure raised
        // after the reply was written (e.g. during reconciliation) never
        // deletes a turn that actually happened.
        if (!assistantPersisted) {
          await db.delete(agentMessages).where(eq(agentMessages.id, userMessageId)).catch(() => {});
        }

        const offPolicy = err instanceof OffPolicyProviderError;
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: 'error',
              code: failure.code,
              ...(offPolicy ? { provider: err.provider } : {}),
              message: failure.message,
              // Tells the client the persisted user row is gone, so it can
              // drop its optimistic echo and hand the text back to the
              // composer rather than stranding it on screen.
              rolledBack: !assistantPersisted,
            }) + '\n',
          ),
        );
      } finally {
        controller.close();
      }
    },
    async cancel() {
      await release();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
