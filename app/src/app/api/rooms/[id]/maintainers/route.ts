import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms, contributors } from '@/db/schema';
import { maintainerChangeSchema } from '@/lib/validation';
import { getCurrentContributorId } from '@/lib/session';

// Maintainer roster management. Without this the roster was fixed at room
// creation forever: a real GitHub user could never be granted adoption
// authority in the seeded room, and no owner could deputize anyone.
//
// Authority: an existing maintainer of the room, derived from the session,
// never from the request body. Non-maintainers get 403.
// Invariant: a room always has at least one maintainer, so removing the
// last one is refused. Combined with the maintainer-only check, that means
// a room can never be orphaned or silently taken over.
//
// The room row is locked FOR UPDATE for the read-modify-write, so two
// concurrent removals cannot both see two maintainers and both remove one.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actingContributorId = await getCurrentContributorId();
  if (!actingContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id: roomId } = await params;
  const body = await request.json();
  const parsed = maintainerChangeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { contributorId, action } = parsed.data;

  const [target] = await db
    .select({ id: contributors.id })
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: `unknown contributor: ${contributorId}` }, { status: 400 });
  }

  const result = await db.transaction(async (tx) => {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
    if (!room) return { kind: 'not_found' as const };
    if (!room.maintainers.includes(actingContributorId)) return { kind: 'forbidden' as const };

    const current = room.maintainers;
    let next: string[];

    if (action === 'add') {
      if (current.includes(contributorId)) return { kind: 'ok' as const, room };
      next = [...current, contributorId];
    } else {
      if (!current.includes(contributorId)) return { kind: 'ok' as const, room };
      next = current.filter((m) => m !== contributorId);
      if (next.length === 0) return { kind: 'last_maintainer' as const };
    }

    const [updated] = await tx
      .update(rooms)
      .set({ maintainers: next })
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
  if (result.kind === 'last_maintainer') {
    return NextResponse.json(
      { error: 'cannot remove the last maintainer of a room' },
      { status: 409 },
    );
  }

  return NextResponse.json({ room: result.room }, { status: 200 });
}
