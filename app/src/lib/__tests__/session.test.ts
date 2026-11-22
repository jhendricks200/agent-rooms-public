import { describe, it, expect, vi, afterEach } from 'vitest';

// session.ts imports the Auth.js config and next/headers at module load.
// Neither is available under vitest, and neither is what these tests are
// about, so both are replaced: `auth()` reports no session (the only case
// in which a fallback could matter) and `headers()` returns whatever the
// test sets.
let sessionContributorId: string | null = null;
vi.mock('@/auth', () => ({
  auth: async () => (sessionContributorId ? { contributorId: sessionContributorId } : null),
}));

let requestHeaders: Record<string, string> = {};
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

import {
  DEV_FALLBACK_CONTRIBUTOR_ID,
  STAGE0_IDENTITY_HEADER,
  devFallbackEnabled,
  getCurrentContributorId,
  onHostedDeployment,
} from '@/lib/session';

const DEV = { NODE_ENV: 'development', DEV_IDENTITY_FALLBACK: '1' } as unknown as NodeJS.ProcessEnv;

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...DEV, ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe('onHostedDeployment', () => {
  it('is false on a plain local machine', () => {
    expect(onHostedDeployment(env({}))).toBe(false);
  });

  it('is true for a Vercel production deployment', () => {
    expect(onHostedDeployment(env({ VERCEL: '1', VERCEL_ENV: 'production' }))).toBe(true);
  });

  it('is true for a Vercel preview deployment', () => {
    expect(onHostedDeployment(env({ VERCEL: '1', VERCEL_ENV: 'preview' }))).toBe(true);
  });

  it('is true when VERCEL_ENV says production even if VERCEL itself is missing', () => {
    expect(onHostedDeployment(env({ VERCEL_ENV: 'production' }))).toBe(true);
  });

  it('is true when VERCEL=1 and VERCEL_ENV is missing (fails closed)', () => {
    expect(onHostedDeployment(env({ VERCEL: '1' }))).toBe(true);
  });

  it('is false under `vercel dev`, which reports VERCEL_ENV=development', () => {
    expect(onHostedDeployment(env({ VERCEL: '1', VERCEL_ENV: 'development' }))).toBe(false);
  });
});

describe('devFallbackEnabled', () => {
  it('is on locally with NODE_ENV=development and the flag set', () => {
    expect(devFallbackEnabled(env({}))).toBe(true);
  });

  it('is off without the flag', () => {
    expect(devFallbackEnabled(env({ DEV_IDENTITY_FALLBACK: undefined }))).toBe(false);
    expect(devFallbackEnabled(env({ DEV_IDENTITY_FALLBACK: '0' }))).toBe(false);
  });

  it('is off when NODE_ENV is production', () => {
    expect(devFallbackEnabled(env({ NODE_ENV: 'production' }))).toBe(false);
  });

  // The case the second gate exists for: a deployment whose NODE_ENV was
  // wrongly left as development and whose flag was wrongly set.
  it('is off on a hosted deployment even when NODE_ENV and the flag are both wrong', () => {
    expect(devFallbackEnabled(env({ VERCEL: '1', VERCEL_ENV: 'production' }))).toBe(false);
    expect(devFallbackEnabled(env({ VERCEL: '1', VERCEL_ENV: 'preview' }))).toBe(false);
    expect(devFallbackEnabled(env({ VERCEL: '1' }))).toBe(false);
  });
});

describe('getCurrentContributorId', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionContributorId = null;
    requestHeaders = {};
  });

  function stubDev() {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_IDENTITY_FALLBACK', '1');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_ENV', '');
  }

  it('returns the real session contributor when there is one', async () => {
    stubDev();
    sessionContributorId = 'contributor_real';
    expect(await getCurrentContributorId()).toBe('contributor_real');
  });

  it('returns null with no session and no fallback flag', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_IDENTITY_FALLBACK', '');
    expect(await getCurrentContributorId()).toBeNull();
  });

  it('resolves the seeded identity locally when the fallback is on', async () => {
    stubDev();
    expect(await getCurrentContributorId()).toBe(DEV_FALLBACK_CONTRIBUTOR_ID);
  });

  it('returns null on a hosted deployment even with NODE_ENV=development and the flag set', async () => {
    stubDev();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await getCurrentContributorId()).toBeNull();
  });

  it('ignores the Stage 0 header on a hosted deployment even with all three dev flags set', async () => {
    stubDev();
    vi.stubEnv('STAGE0_IDENTITY_OVERRIDE', '1');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    requestHeaders[STAGE0_IDENTITY_HEADER] = 'contributor_someone_else';
    expect(await getCurrentContributorId()).toBeNull();
  });

  it('honors the Stage 0 header locally when all three dev flags are set', async () => {
    stubDev();
    vi.stubEnv('STAGE0_IDENTITY_OVERRIDE', '1');
    requestHeaders[STAGE0_IDENTITY_HEADER] = 'contributor_persona';
    expect(await getCurrentContributorId()).toBe('contributor_persona');
  });
});
