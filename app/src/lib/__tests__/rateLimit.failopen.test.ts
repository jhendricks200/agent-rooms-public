import { describe, it, expect, vi, afterEach } from 'vitest';

// Kept apart from rateLimit.test.ts because it replaces the database
// client for the whole file. The only thing under test is what
// checkRateLimit does when the transaction itself fails.
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { transaction } }));

import { checkRateLimit } from '@/lib/rateLimit';

describe('checkRateLimit when the database call fails', () => {
  afterEach(() => {
    transaction.mockReset();
    vi.restoreAllMocks();
  });

  it('fails open, and says so, when the rate_limit_events table does not exist', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = Object.assign(new Error('relation "rate_limit_events" does not exist'), { code: '42P01' });
    // drizzle reports driver errors as the cause of its own error.
    transaction.mockRejectedValueOnce(new Error('Failed query', { cause: missing }));

    expect(await checkRateLimit('contributor_x', 'message.post')).toEqual({ allowed: true });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('[SECURITY] rate limiting is OFF');
  });

  it('rethrows every other database error instead of letting the request through', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    transaction.mockRejectedValueOnce(new Error('connection refused'));

    await expect(checkRateLimit('contributor_x', 'message.post')).rejects.toThrow('connection refused');
    expect(logged).not.toHaveBeenCalled();
  });
});
