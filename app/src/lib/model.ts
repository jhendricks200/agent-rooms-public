// OpenRouter chat completions client for the sidebar agent.
//
// Model: GPT-5.6 Luna (still the near-free tier per docs/design/
// promote-provenance.md Model policy section: $0.10/M in, $0.60/M out on
// OpenRouter after OpenAI's 2026-07-30 price cut; the whole Stage 0 run
// re-costed at under a nickel). Switched from DeepSeek V4-Flash on
// 2026-07-30: same cost class, and a first-party US provider removes the
// model-origin question testers would otherwise ask.
//
// ROUTING RULE (verified 2026-07-30 against
// https://openrouter.ai/api/v1/models/openai/gpt-5.6-luna/endpoints):
// pin to OpenAI's first-party endpoint only. The other listed providers
// (Amazon Bedrock us-east-1, Azure incl. azure/eu) are also US/EU-hosted,
// but a single first-party pin keeps the attestation story trivial. The
// pin-and-attest gate stays even though the off-policy-reseller risk that
// motivated it under DeepSeek is gone: it is cheap, and it means a future
// model swap cannot silently reopen the question.
export const PINNED_US_EU_PROVIDER_SLUGS = ['openai'] as const;

const MODEL_ID = 'openai/gpt-5.6-luna';

// Hardcoded production endpoint. See resolveBaseUrl below: MODEL_BASE_URL
// is only ever honored outside production.
const PRODUCTION_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// SECURITY: MODEL_BASE_URL is an env-controlled escape hatch that exists
// only so verify:agent can point at a local mock server when the
// OpenRouter account has no credits yet. If honored in production, it lets
// anyone who can set an env var (a misconfigured deploy, a compromised CI
// job, a careless copy-paste) redirect every inference call, bearer key
// included, to an arbitrary host that can log the API key and read every
// private agent prompt. It is therefore gated to non-production only; the
// production base URL is always the hardcoded constant above.
function resolveBaseUrl(): string {
  if (process.env.NODE_ENV !== 'production') {
    return process.env.MODEL_BASE_URL ?? PRODUCTION_OPENROUTER_BASE_URL;
  }
  return PRODUCTION_OPENROUTER_BASE_URL;
}

function overrideActive(): boolean {
  return process.env.NODE_ENV !== 'production' && !!process.env.MODEL_BASE_URL;
}

// Returns true only when a served provider is present AND inside the
// pinned US/EU allowlist. A missing provider is NOT allowed: "we could not
// confirm where this request was served" is not a weaker claim than "it was
// served somewhere off-policy", it is the same claim. Treating it as
// allowed meant an endpoint that simply omits the field bypassed the pin
// entirely.
export function isAllowedProvider(provider: string | null): boolean {
  if (!provider) return false;
  return (PINNED_US_EU_PROVIDER_SLUGS as readonly string[]).includes(provider.toLowerCase());
}

// Thrown as soon as a chunk reveals a provider outside the pin, or when a
// stream ends without ever attesting one. The stream is aborted at that
// point: no further tokens are read, and the caller must not persist the
// partial response as a normal assistant message.
export class OffPolicyProviderError extends Error {
  provider: string | null;
  constructor(provider: string | null) {
    super(
      provider
        ? `model request was served by off-policy provider "${provider}"; response discarded`
        : 'model request completed without a provider attestation; response discarded',
    );
    this.provider = provider;
  }
}

function logOffPolicy(provider: string | null) {
  console.error(
    `[SECURITY] off-policy model provider served a request: "${provider ?? '(none attested)'}" is not in the pinned US/EU allowlist (${PINNED_US_EU_PROVIDER_SLUGS.join(', ')}). Check OpenRouter provider routing config immediately.`,
  );
}

// Raised when the provider endpoint itself refuses the request (an HTTP
// error rather than a stream we can read). `status` and `detail` are kept
// as structured fields so the route can classify the failure — upstream
// rate limiting, a credentials/credit problem, a provider outage — instead
// of regex-matching a flattened message. `detail` is the raw provider body:
// it is for the server log and a collapsed disclosure, never for the
// user-facing line.
export class ModelRequestError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`model request failed: ${status} ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  // Provider that actually served the request, read from OpenRouter's
  // top-level `provider` field on each streamed chunk (verified live
  // against the real API on 2026-07-24: every chunk, including the final
  // usage chunk, carries `"provider":"DeepInfra"` for a deepinfra-routed
  // request; OpenRouter's docs site is JS-rendered and did not yield the
  // field name via static fetch, so this was confirmed by inspecting a
  // real streamed response instead). null when the stream never included
  // one (e.g. a local mock server).
  provider: string | null;
}

// Streams a chat completion, calling onToken for each text delta as it
// arrives, and resolves with the full text plus token usage once the stream
// ends. Usage numbers come from the trailing SSE usage chunk (OpenRouter
// sends one when `usage.include: true` is set); if a mock server omits it,
// tokensIn/tokensOut fall back to a rough word-count estimate so the daily
// cap still has something to subtract.
export async function streamChatCompletion(
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  opts?: { maxOutputTokens?: number },
): Promise<StreamResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey && !overrideActive()) {
    throw new Error('OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }

  const body: Record<string, unknown> = {
    model: MODEL_ID,
    messages,
    stream: true,
    usage: { include: true },
  };

  // Hard output bound. The reservation sized this request assuming at most
  // this many completion tokens; sending it as max_tokens is what makes
  // that assumption true rather than hopeful.
  if (opts?.maxOutputTokens != null) {
    body.max_tokens = opts.maxOutputTokens;
  }

  // Provider pin only applies to the real OpenRouter endpoint. A local mock
  // server (MODEL_BASE_URL override, used by verify:agent pending credits)
  // does not do provider routing, so the field is harmless there but is
  // still sent for parity with production request shape.
  body.provider = {
    only: [...PINNED_US_EU_PROVIDER_SLUGS],
    allow_fallbacks: false,
    data_collection: 'deny',
  };

  const res = await fetch(`${resolveBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey ?? 'mock'}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new ModelRequestError(res.status, detail);
  }

  // The provider gate is skipped only when the non-production
  // MODEL_BASE_URL override is active, i.e. a local mock server that does
  // no provider routing and cannot attest anything. That override is
  // already hard-gated to non-production above; production always gates.
  const attestationBypassed = overrideActive();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let provider: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        provider?: string;
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        onToken(delta);
      }
      if (parsed.usage) {
        tokensIn = parsed.usage.prompt_tokens ?? tokensIn;
        tokensOut = parsed.usage.completion_tokens ?? tokensOut;
      }
      // Provider attestation: OpenRouter sets a top-level `provider` field
      // on every streamed chunk naming the endpoint that actually served
      // the request (e.g. "DeepInfra"), independent of and in addition to
      // `model`. The check is a gate, not a log line: the very first chunk
      // that carries one decides whether this request continues at all, so
      // an off-policy endpoint never gets to stream a whole response into
      // a private session before anyone notices.
      if (parsed.provider) {
        provider = parsed.provider;
        if (!attestationBypassed && !isAllowedProvider(provider)) {
          logOffPolicy(provider);
          await reader.cancel().catch(() => {});
          throw new OffPolicyProviderError(provider);
        }
      }
    }
  }

  if (!attestationBypassed && !isAllowedProvider(provider)) {
    // Stream ended without ever attesting a provider. Fail closed.
    logOffPolicy(provider);
    throw new OffPolicyProviderError(provider);
  }

  if (tokensIn === 0 && tokensOut === 0) {
    // Fallback estimate: ~0.75 words per token, rough enough for the cap.
    const inputWords = messages.reduce((n, m) => n + m.content.split(/\s+/).length, 0);
    tokensIn = Math.ceil(inputWords / 0.75);
    tokensOut = Math.ceil(fullText.split(/\s+/).length / 0.75);
  }

  return { text: fullText, tokensIn, tokensOut, provider };
}
