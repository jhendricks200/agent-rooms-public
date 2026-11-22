import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentMessages, agentSessions, rooms } from '@/db/schema';
import { makeContributor, makeRoom, makeProposal, makeVersion, makeFork, cleanup } from './testDb';

async function findSessionId(roomId: string, ownerContributorId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.roomId, roomId), eq(agentSessions.ownerContributorId, ownerContributorId)))
    .limit(1);
  return row?.id;
}

const streamChatCompletionMock = vi.fn();

class FakeOffPolicyProviderError extends Error {
  provider: string | null;
  constructor(provider: string | null) {
    super(`off-policy provider "${provider}"`);
    this.provider = provider;
  }
}

class FakeModelRequestError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`model request failed: ${status} ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

vi.mock('@/lib/model', () => ({
  streamChatCompletion: (...args: unknown[]) => streamChatCompletionMock(...args),
  isAllowedProvider: (provider: string | null) =>
    !!provider && ['openai'].includes(provider.toLowerCase()),
  OffPolicyProviderError: FakeOffPolicyProviderError,
  ModelRequestError: FakeModelRequestError,
}));

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

async function drainStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Record<string, unknown>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const p of parts) {
      if (!p.trim()) continue;
      events.push(JSON.parse(p));
    }
  }
  return events;
}

const ENV_KEYS = ['AGENT_DAILY_TOKEN_CAP'] as const;
const originalEnv: Record<string, string | undefined> = {};

describe('POST /api/agent/message', () => {
  let contributorId: string;
  const roomIds: string[] = [];
  const contributorIds: string[] = [];
  const sessionIds: string[] = [];
  const proposalIds: string[] = [];

  beforeEach(async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    streamChatCompletionMock.mockReset();
    contributorId = await makeContributor();
    contributorIds.push(contributorId);
    currentContributorId = contributorId;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await cleanup({
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
      sessionIds: sessionIds.splice(0),
      proposalIds: proposalIds.splice(0),
    });
  });

  async function importRoute() {
    return import('@/app/api/agent/message/route');
  }

  it('423s and calls no model when the room kill switch is enabled', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], killSwitchEnabled: true });
    roomIds.push(roomId);

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(423);
    const json = await res.json();
    expect(json.error).toBe('kill_switch_enabled');
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('429s with room_budget_exceeded when the room token budget is already used up', async () => {
    const roomId = await makeRoom({
      maintainers: [contributorId],
      tokenBudgetPerRoom: 100,
      tokenBudgetUsed: 100,
    });
    roomIds.push(roomId);

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('room_budget_exceeded');
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('429s with user_budget_exceeded when tokenBudgetPerUser is smaller than the estimate', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerUser: 10 });
    roomIds.push(roomId);

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('user_budget_exceeded');
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('429s with daily_cap_exceeded once AGENT_DAILY_TOKEN_CAP is exhausted', async () => {
    process.env.AGENT_DAILY_TOKEN_CAP = '10';
    const roomId = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomId);

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('daily_cap_exceeded');
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('streams a reply, persists servedProvider, and reconciles the reservation on an allowed provider', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockResolvedValue({ text: 'hi there', tokensIn: 10, tokensOut: 5, provider: 'OpenAI' });

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(200);
    const events = await drainStream(res);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    expect(done!.provider).toBe('OpenAI');
    expect(done!.offPolicy).toBe(false);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(15); // reconciled down to actual (10 + 5), not the estimate

    const assistantRows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.role, 'assistant'));
    const row = assistantRows.find((r) => r.content === 'hi there');
    expect(row?.servedProvider).toBe('OpenAI');
    expect(row?.offPolicy).toBe(false);

    // find the session created for this room so it gets cleaned up
    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  // Fail-closed attestation: an off-policy provider aborts the stream in
  // lib/model.ts, so the route persists no assistant message at all,
  // releases the reservation, and returns a clear error. The response is
  // never quietly stored with an off-policy flag on it.
  it('discards the response and releases the reservation when the provider is off-policy', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockRejectedValue(new FakeOffPolicyProviderError('DeepSeek'));

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    expect(res.status).toBe(200);
    const events = await drainStream(res);

    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    const error = events.find((e) => e.type === 'error');
    expect(error!.code).toBe('off_policy_provider');
    expect(error!.provider).toBe('DeepSeek');

    const assistantRows = await db.select().from(agentMessages).where(eq(agentMessages.role, 'assistant'));
    expect(assistantRows.find((r) => r.content.includes('ni hao'))).toBeUndefined();

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(0);

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  it('passes a hard max_tokens bound to the model, matching the reserved output allowance', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockResolvedValue({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'OpenAI' });

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    await drainStream(res);

    const { MAX_OUTPUT_TOKENS } = await import('@/lib/budget');
    expect(streamChatCompletionMock.mock.calls[0][2]).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS });

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  it('releases the reservation (tokenBudgetUsed returns to 0) when the model call fails', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockRejectedValue(new Error('upstream exploded'));

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    const events = await drainStream(res);
    expect(events.find((e) => e.type === 'error')).toBeTruthy();

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.tokenBudgetUsed).toBe(0);

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  // Defect 1: the provider's own body (JSON, provider name, an OpenRouter
  // settings link) was rendered verbatim in the private transcript. The
  // user-facing line must be one human sentence; the raw body goes to the
  // server log only and never crosses the wire.
  it('reports an upstream 429 in human copy and keeps the raw provider body out of the stream', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    const rawBody =
      '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"rate-limited upstream, see https://openrouter.ai/settings/integrations","provider_name":"DeepInfra"}}}';
    streamChatCompletionMock.mockRejectedValue(new FakeModelRequestError(429, rawBody));

    const { POST } = await importRoute();
    const res = await POST(fakeRequest({ roomId, content: 'hello' }));
    const events = await drainStream(res);
    const error = events.find((e) => e.type === 'error');

    expect(error).toBeTruthy();
    expect(error!.code).toBe('provider_rate_limited');
    const message = String(error!.message);
    expect(message).not.toContain('{');
    expect(message).not.toContain('openrouter.ai');
    expect(message).not.toContain('DeepInfra');
    expect(message).toContain('rate-limiting');
    // The raw provider body is server-log-only now; the maintainer reads
    // it there, not out of the client stream.
    expect(error!.detail).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('openrouter.ai');

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  // Defect 2: a failed turn used to leave the user's row persisted with no
  // reply, which came back on the next load and made a retry render the same
  // prompt twice. No reply means the exchange did not happen.
  it('rolls the user message back when the turn fails, so a retry cannot duplicate it', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockRejectedValue(new FakeModelRequestError(429, 'rate limited'));

    const { POST, GET } = await importRoute();
    const failed = await POST(fakeRequest({ roomId, content: 'a prompt that fails' }));
    const events = await drainStream(failed);
    expect(events.find((e) => e.type === 'error')!.rolledBack).toBe(true);

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);

    const stranded = await db.select().from(agentMessages).where(eq(agentMessages.sessionId, sessionId!));
    expect(stranded).toHaveLength(0);

    // The retry succeeds, and the transcript holds exactly one copy.
    streamChatCompletionMock.mockResolvedValue({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'OpenAI' });
    await drainStream(await POST(fakeRequest({ roomId, content: 'a prompt that fails' })));

    const history = await (
      await GET({
        nextUrl: { searchParams: new URLSearchParams({ roomId }) },
      } as unknown as import('next/server').NextRequest)
    ).json();
    const userTurns = history.messages.filter(
      (m: { role: string; content: string }) => m.role === 'user' && m.content === 'a prompt that fails',
    );
    expect(userTurns).toHaveLength(1);
  });

  // The off-policy abort is a provenance control, and its copy is
  // deliberate. Classification must not reword or swallow it.
  it('preserves the off-policy provider message and code verbatim', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 100_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockRejectedValue(new FakeOffPolicyProviderError('DeepSeek'));

    const { POST } = await importRoute();
    const events = await drainStream(await POST(fakeRequest({ roomId, content: 'hello' })));
    const error = events.find((e) => e.type === 'error');

    expect(error!.code).toBe('off_policy_provider');
    expect(error!.provider).toBe('DeepSeek');
    expect(error!.message).toBe('off-policy provider "DeepSeek"');

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  // The core TOCTOU fix at the route level: two genuinely parallel POSTs
  // against a room budget that can only admit one of them.
  it('concurrency: two parallel POSTs that together exceed the room budget let exactly one proceed', async () => {
    const roomId = await makeRoom({ maintainers: [contributorId], tokenBudgetPerRoom: 6_000 });
    roomIds.push(roomId);
    streamChatCompletionMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: 'ok', tokensIn: 10, tokensOut: 5, provider: 'OpenAI' }), 30),
        ),
    );

    const { POST } = await importRoute();
    const [resA, resB] = await Promise.all([
      POST(fakeRequest({ roomId, content: 'first message' })),
      POST(fakeRequest({ roomId, content: 'second message' })),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 429]);

    for (const res of [resA, resB]) {
      if (res.status === 200) await drainStream(res);
    }

    const sessionId = await findSessionId(roomId, contributorId);
    if (sessionId) sessionIds.push(sessionId);
  });

  it('buildSystemPrompt scopes the fork bundle to the given room, not other rooms the same contributor forked in', async () => {
    const { buildSystemPrompt } = await importRoute();

    const roomA = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomA);
    const roomB = await makeRoom({ maintainers: [contributorId] });
    roomIds.push(roomB);

    const proposalA = await makeProposal({ roomId: roomA, authorContributorId: contributorId });
    proposalIds.push(proposalA);
    const versionA = await makeVersion({ proposalId: proposalA });
    await makeFork({ proposalId: proposalA, proposalVersionId: versionA, byContributorId: contributorId });

    const proposalB = await makeProposal({ roomId: roomB, authorContributorId: contributorId });
    proposalIds.push(proposalB);
    const versionB = await makeVersion({ proposalId: proposalB });
    await makeFork({ proposalId: proposalB, proposalVersionId: versionB, byContributorId: contributorId });

    const promptForA = await buildSystemPrompt(roomA, 'unused-session-id');
    expect(promptForA).toContain(proposalA);
    expect(promptForA).not.toContain(proposalB);
  });
});
