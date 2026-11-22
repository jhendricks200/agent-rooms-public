import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Builds a fake fetch Response whose body streams the given SSE `data:`
// payloads, matching the shape of a real OpenRouter streaming response.
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('lib/model', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // NODE_ENV is typed readonly (Next.js augments ProcessEnv), so tests
    // that need to flip it use vi.stubEnv rather than a direct assignment.
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchSpy.mockRestore();
    vi.resetModules();
  });

  it('honors MODEL_BASE_URL outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_BASE_URL', 'http://localhost:9999/v1');
    fetchSpy.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'hi' } }], provider: 'OpenAI' }]));

    const { streamChatCompletion } = await import('@/lib/model');
    await streamChatCompletion([{ role: 'user', content: 'hi' }], () => {});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:9999/v1/chat/completions');
  });

  it('ignores MODEL_BASE_URL and uses the hardcoded OpenRouter URL in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MODEL_BASE_URL', 'https://attacker.example/v1');
    fetchSpy.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'hi' } }], provider: 'OpenAI' }]));

    const { streamChatCompletion } = await import('@/lib/model');
    await streamChatCompletion([{ role: 'user', content: 'hi' }], () => {});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calledUrl).not.toContain('attacker.example');
  });

  // Fail closed: a missing attestation is not "nothing to flag", it is
  // "we cannot confirm where this was served", which is the same risk as
  // a confirmed off-policy provider.
  it('isAllowedProvider accepts the pinned slug case-insensitively and rejects a missing provider', async () => {
    const { isAllowedProvider } = await import('@/lib/model');
    expect(isAllowedProvider('OpenAI')).toBe(true);
    expect(isAllowedProvider('openai')).toBe(true);
    expect(isAllowedProvider(null)).toBe(false);
    expect(isAllowedProvider('')).toBe(false);
    // Formerly pinned hosts for the DeepSeek era are off-policy now that
    // the pin is first-party only.
    expect(isAllowedProvider('DeepInfra')).toBe(false);
    expect(isAllowedProvider('DeepSeek')).toBe(false);
    expect(isAllowedProvider('SiliconFlow')).toBe(false);
  });

  it('aborts the stream on an off-policy provider, discards the response, and logs loudly', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_BASE_URL', undefined);
    fetchSpy.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: 'ni hao' } }], provider: 'DeepSeek' },
        { choices: [{ delta: { content: ' more text' } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, provider: 'DeepSeek' },
      ]),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { streamChatCompletion, OffPolicyProviderError } = await import('@/lib/model');

    const tokens: string[] = [];
    await expect(
      streamChatCompletion([{ role: 'user', content: 'hi' }], (d) => tokens.push(d)),
    ).rejects.toBeInstanceOf(OffPolicyProviderError);

    // Aborted at the first chunk that carried the provider, so the rest of
    // the response was never streamed to the caller.
    expect(tokens.join('')).not.toContain('more text');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[SECURITY]'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DeepSeek'));
    errSpy.mockRestore();
  });

  it('fails closed when a real endpoint never attests a provider at all', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_BASE_URL', undefined);
    fetchSpy.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'hi' } }] }]));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { streamChatCompletion, OffPolicyProviderError } = await import('@/lib/model');

    await expect(
      streamChatCompletion([{ role: 'user', content: 'hi' }], () => {}),
    ).rejects.toBeInstanceOf(OffPolicyProviderError);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[SECURITY]'));
    errSpy.mockRestore();
  });

  it('sends max_tokens so actual output cannot exceed the reserved allowance', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_BASE_URL', undefined);
    fetchSpy.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'hi' } }], provider: 'OpenAI' }]));

    const { streamChatCompletion } = await import('@/lib/model');
    await streamChatCompletion([{ role: 'user', content: 'hi' }], () => {}, { maxOutputTokens: 4_000 });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).max_tokens).toBe(4_000);
  });

  it('records an allowed provider without warning', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MODEL_BASE_URL', undefined);
    fetchSpy.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: 'hi there' } }], provider: 'OpenAI' },
        { choices: [{ delta: { content: '' } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, provider: 'OpenAI' },
      ]),
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { streamChatCompletion } = await import('@/lib/model');
    const result = await streamChatCompletion([{ role: 'user', content: 'hi' }], () => {});

    expect(result.provider).toBe('OpenAI');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
