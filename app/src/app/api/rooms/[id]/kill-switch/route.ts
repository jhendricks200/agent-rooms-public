import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { killSwitchSchema } from '@/lib/validation';
import { getCurrentContributorId } from '@/lib/session';

// The room agent kill switch. rooms.killSwitchEnabled is enforced on the
// agent admission path (lib/budget.ts reserveUsage returns 'kill_switch',
// which the agent message route turns into a 423), but until this route
// existed nothing in the app could set it: a room going wrong with
// strangers in it could only be stopped from a database console. See
// docs/design/promote-provenance.md, Safety mechanics item 4.
//
// Authority: a maintainer of the room, derived from the session, never from
// the request body. Non-maintainers get 403, anonymous callers 401. Error
// bodies match api/rooms/[id]/maintainers/route.ts exactly.
//
// Idempotent by construction: the body names the desired state rather than
// asking for a toggle, and setting the switch to the value it already has
// is a successful no-op. An emergency control that errored or flipped back
// on a double-click would be worse than useless.
//
// The room row is locked FOR UPDATE for the read-check-write, so two
// concurrent flips cannot interleave: the second transaction blocks until
// the first commits and then re-reads the room, and the row that is
// returned is always the state that was actually committed.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actingContributorId = await getCurrentContributorId();
  if (!actingContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id: roomId } = await params;
  const body = await request.json();
  const parsed = killSwitchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { roomId: bodyRoomId, enabled } = parsed.data;

  // Refused rather than silently preferring one of the two: a body aimed at
  // a different room than the path is a bug or a replay, and quietly
  // stopping (or restarting) the wrong room's agent is exactly the mistake
  // this control exists to prevent.
  if (bodyRoomId !== roomId) {
    return NextResponse.json(
      { error: `roomId in body does not match the room in the path: ${bodyRoomId} != ${roomId}` },
      { status: 400 },
    );
  }

  const result = await db.transaction(async (tx) => {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
    if (!room) return { kind: 'not_found' as const };
    if (!room.maintainers.includes(actingContributorId)) return { kind: 'forbidden' as const };

    if (room.killSwitchEnabled === enabled) return { kind: 'ok' as const, room };

    const [updated] = await tx
      .update(rooms)
      .set({ killSwitchEnabled: enabled })
      .where(eq(rooms.id, roomId))
      .returning();
    return { kind: 'ok' as const, room: updated };
  });

  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'room not found' }, { status: 404 });
  }
  if (result.kind === 'forbidden') {
    return NextResponse.json(
      { error: 'acting contributor is not a maintainer of this room' },
      { status: 403 },
    );
  }

  return NextResponse.json({ room: result.room }, { status: 200 });
}
