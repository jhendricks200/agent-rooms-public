import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { makeContributor, makeRoom, cleanup } from './testDb';

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('POST /api/rooms/[id]/maintainers', () => {
  let ownerId: string;
  let outsiderId: string;
  let roomId: string;
  const roomIds: string[] = [];
  const contributorIds: string[] = [];

  beforeEach(async () => {
    ownerId = await makeContributor('Owner');
    outsiderId = await makeContributor('Outsider');
    contributorIds.push(ownerId, outsiderId);
    roomId = await makeRoom({ maintainers: [ownerId] });
    roomIds.push(roomId);
    currentContributorId = ownerId;
  });

  afterEach(async () => {
    await cleanup({ roomIds: roomIds.splice(0), contributorIds: contributorIds.splice(0) });
  });

  async function importRoute() {
    const mod = await import('@/app/api/rooms/[id]/maintainers/route');
    return mod.POST;
  }

  const params = () => ({ params: Promise.resolve({ id: roomId }) });

  it('401s an anonymous caller', async () => {
    currentContributorId = null;
    const POST = await importRoute();
    const res = await POST(fakeRequest({ contributorId: outsiderId, action: 'add' }), params());
    expect(res.status).toBe(401);
  });

  it('lets an existing maintainer add another contributor', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest({ contributorId: outsiderId, action: 'add' }), params());
    expect(res.status).toBe(200);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.maintainers.sort()).toEqual([ownerId, outsiderId].sort());
  });

  it('403s a non-maintainer trying to add themselves', async () => {
    currentContributorId = outsiderId;
    const POST = await importRoute();
    const res = await POST(fakeRequest({ contributorId: outsiderId, action: 'add' }), params());
    expect(res.status).toBe(403);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.maintainers).toEqual([ownerId]);
  });

  it('lets a maintainer remove another maintainer', async () => {
    const POST = await importRoute();
    await POST(fakeRequest({ contributorId: outsiderId, action: 'add' }), params());
    const res = await POST(fakeRequest({ contributorId: outsiderId, action: 'remove' }), params());
    expect(res.status).toBe(200);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.maintainers).toEqual([ownerId]);
  });

  // A room with no maintainers can never be adopted into again, and nobody
  // could restore the roster through this route either.
  it('refuses to remove the last maintainer', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest({ contributorId: ownerId, action: 'remove' }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last maintainer/);

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    expect(room.maintainers).toEqual([ownerId]);
  });

  it('400s an unknown contributor id', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest({ contributorId: 'contributor_nope', action: 'add' }), params());
    expect(res.status).toBe(400);
  });

  it('400s a body carrying an unexpected field', async () => {
    const POST = await importRoute();
    const res = await POST(
      fakeRequest({ contributorId: outsiderId, action: 'add', roomId: 'other-room' }),
      params(),
    );
    expect(res.status).toBe(400);
  });
});
