import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { getCurrentContributorId } from '@/lib/session';

// Reads are authenticated. A room's contents (its repo ref, maintainer
// roster, budgets) are not public: an anonymous caller gets 401, never the
// row. The development identity fallback in lib/session.ts still applies,
// so local verify scripts are unaffected.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const contributorId = await getCurrentContributorId();
  if (!contributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await params;

  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);

  if (!room) {
    return NextResponse.json({ error: 'room not found' }, { status: 404 });
  }

  return NextResponse.json({ room });
}
