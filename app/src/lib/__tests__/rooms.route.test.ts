import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { makeContributor, cleanup } from './testDb';
import { RATE_LIMITS } from '@/lib/rateLimit';

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('POST /api/rooms', () => {
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  afterEach(async () => {
    for (const id of roomIds.splice(0)) {
      await db.delete(rooms).where(eq(rooms.id, id));
    }
    await cleanup({ contributorIds: contributorIds.splice(0) });
    currentContributorId = null;
  });

  async function importRoute() {
    const mod = await import('@/app/api/rooms/route');
    return mod.POST;
  }

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Test Room',
      discordChannelRef: 'discord:test',
      githubRepoRef: 'test-owner/test-repo',
      ...overrides,
    };
  }

  it('401s when there is no session and no dev fallback', async () => {
    currentContributorId = null;
    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(401);
  });

  it('rejects a client-supplied maintainers array with 400 (schema is strict, field does not exist)', async () => {
    const creator = await makeContributor();
    contributorIds.push(creator);
    currentContributorId = creator;

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody({ maintainers: ['contributor_evil'] })));
    expect(res.status).toBe(400);
  });

  it('rejects a client-supplied createdBy with 400', async () => {
    const creator = await makeContributor();
    contributorIds.push(creator);
    currentContributorId = creator;

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody({ createdBy: 'contributor_evil' })));
    expect(res.status).toBe(400);
  });

  it('creates a room whose maintainers equal exactly the session contributor', async () => {
    const creator = await makeContributor();
    contributorIds.push(creator);
    currentContributorId = creator;

    const POST = await importRoute();
    const res = await POST(fakeRequest(validBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    roomIds.push(json.room.id);

    expect(json.room.maintainers).toEqual([creator]);
    expect(json.room.createdBy).toBe(creator);
  });

  it('429s with Retry-After once a contributor passes the room creation ceiling, and creates nothing', async () => {
    const creator = await makeContributor();
    contributorIds.push(creator);
    currentContributorId = creator;

    const POST = await importRoute();
    const { max, windowSeconds } = RATE_LIMITS['room.create'];
    for (let i = 0; i < max; i++) {
      const ok = await POST(fakeRequest(validBody()));
      expect(ok.status).toBe(201);
      roomIds.push((await ok.json()).room.id);
    }

    const refused = await POST(fakeRequest(validBody()));
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
    expect(await refused.json()).toMatchObject({ error: 'rate limit exceeded', action: 'room.create' });

    const created = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.createdBy, creator));
    expect(created).toHaveLength(max);
  });

  it('counts a malformed request toward the ceiling, since the limit is checked before the body is read', async () => {
    const creator = await makeContributor();
    contributorIds.push(creator);
    currentContributorId = creator;

    const POST = await importRoute();
    const { max } = RATE_LIMITS['room.create'];
    for (let i = 0; i < max; i++) {
      const bad = await POST(fakeRequest(validBody({ createdBy: 'contributor_evil' })));
      expect(bad.status).toBe(400);
    }
    const refused = await POST(fakeRequest(validBody()));
    expect(refused.status).toBe(429);
  });
});
