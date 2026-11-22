import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { reserveUsage } from '@/lib/budget';
import { makeContributor, makeRoom, makeAgentSession, cleanup } from './testDb';

let currentContributorId: string | null = null;
vi.mock('@/lib/session', () => ({
  getCurrentContributorId: async () => currentContributorId,
}));

function fakeRequest(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

describe('POST /api/rooms/[id]/kill-switch', () => {
  let ownerId: string;
  let outsiderId: string;
  let roomId: string;
  const roomIds: string[] = [];
  const contributorIds: string[] = [];
  const sessionIds: string[] = [];

  beforeEach(async () => {
    ownerId = await makeContributor('Owner');
    outsiderId = await makeContributor('Outsider');
    contributorIds.push(ownerId, outsiderId);
    roomId = await makeRoom({ maintainers: [ownerId] });
    roomIds.push(roomId);
    currentContributorId = ownerId;
  });

  afterEach(async () => {
    await cleanup({
      roomIds: roomIds.splice(0),
      contributorIds: contributorIds.splice(0),
      sessionIds: sessionIds.splice(0),
    });
  });

  async function importRoute() {
    const mod = await import('@/app/api/rooms/[id]/kill-switch/route');
    return mod.POST;
  }

  const params = () => ({ params: Promise.resolve({ id: roomId }) });

  async function readSwitch() {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return room.killSwitchEnabled;
  }

  it('401s an anonymous caller and leaves the switch alone', async () => {
    currentContributorId = null;
    const POST = await importRoute();
    const res = await POST(fakeRequest({ roomId, enabled: true }), params());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
    expect(await readSwitch()).toBe(false);
  });

  it('403s a non-maintainer and leaves the switch alone', async () => {
    currentContributorId = outsiderId;
    const POST = await importRoute();
    const res = await POST(fakeRequest({ roomId, enabled: true }), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('acting contributor is not a maintainer of this room');
    expect(await readSwitch()).toBe(false);
  });

  it('404s a room that does not exist', async () => {
    const POST = await importRoute();
    const missingId = 'room_test_does_not_exist';
    const res = await POST(fakeRequest({ roomId: missingId, enabled: true }), {
      params: Promise.resolve({ id: missingId }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('room not found');
  });

  it('lets a maintainer enable the switch and returns the updated room', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest({ roomId, enabled: true }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).room.killSwitchEnabled).toBe(true);
    expect(await readSwitch()).toBe(true);
  });

  it('lets a maintainer disable the switch again', async () => {
    const POST = await importRoute();
    await POST(fakeRequest({ roomId, enabled: true }), params());
    const res = await POST(fakeRequest({ roomId, enabled: false }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).room.killSwitchEnabled).toBe(false);
    expect(await readSwitch()).toBe(false);
  });

  // An emergency control must be safe to hit twice: a second enable is a
  // successful no-op, not an error and not a toggle back off.
  it('treats a repeat of the current state as a successful no-op', async () => {
    const POST = await importRoute();
    const first = await POST(fakeRequest({ roomId, enabled: true }), params());
    expect(first.status).toBe(200);
    const second = await POST(fakeRequest({ roomId, enabled: true }), params());
    expect(second.status).toBe(200);
    expect((await second.json()).room.killSwitchEnabled).toBe(true);
    expect(await readSwitch()).toBe(true);

    const offOnAlreadyOff = await POST(fakeRequest({ roomId, enabled: false }), params());
    expect(offOnAlreadyOff.status).toBe(200);
    const offAgain = await POST(fakeRequest({ roomId, enabled: false }), params());
    expect(offAgain.status).toBe(200);
    expect((await offAgain.json()).room.killSwitchEnabled).toBe(false);
    expect(await readSwitch()).toBe(false);
  });

  it('400s a body carrying an unexpected field, including an actor id', async () => {
    const POST = await importRoute();
    const res = await POST(
      fakeRequest({ roomId, enabled: true, actingContributorId: outsiderId }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(await readSwitch()).toBe(false);
  });

  it('400s a body whose roomId disagrees with the path', async () => {
    const POST = await importRoute();
    const res = await POST(fakeRequest({ roomId: 'room_test_other', enabled: true }), params());
    expect(res.status).toBe(400);
    expect(await readSwitch()).toBe(false);
  });

  // The point of the route: once flipped, the agent admission path in
  // lib/budget.ts actually refuses. Without this the switch could be set
  // and enforced nowhere.
  it('makes reserveUsage refuse with kind kill_switch once enabled, and admit again once disabled', async () => {
    const sessionId = await makeAgentSession({ ownerContributorId: ownerId, roomId });
    sessionIds.push(sessionId);

    const before = await reserveUsage({
      roomId,
      sessionId,
      contributorId: ownerId,
      estimatedTokens: 100,
    });
    expect(before.kind).toBe('ok');

    const POST = await importRoute();
    expect((await POST(fakeRequest({ roomId, enabled: true }), params())).status).toBe(200);

    const during = await reserveUsage({
      roomId,
      sessionId,
      contributorId: ownerId,
      estimatedTokens: 100,
    });
    expect(during.kind).toBe('kill_switch');

    expect((await POST(fakeRequest({ roomId, enabled: false }), params())).status).toBe(200);

    const after = await reserveUsage({
      roomId,
      sessionId,
      contributorId: ownerId,
      estimatedTokens: 100,
    });
    expect(after.kind).toBe('ok');
  });
});
