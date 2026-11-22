import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { createRoomSchema } from '@/lib/validation';
import { generateId } from '@/lib/ids';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

// Room creation authority: the creator is always the server-derived
// session contributor, never a client-supplied id (createRoomSchema is
// .strict() and has no createdBy/maintainers fields at all). The creator
// is initialized as the sole maintainer; a client cannot plant an
// arbitrary maintainers roster on a room it just created.
export async function POST(request: NextRequest) {
  const creatorContributorId = await getCurrentContributorId();
  if (!creatorContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(creatorContributorId, 'room.create');
  if (limited) return limited;

  const body = await request.json();
  const parsed = createRoomSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  const id = generateId('room');

  const [room] = await db
    .insert(rooms)
    .values({
      id,
      name: data.name,
      discordChannelRef: data.discordChannelRef,
      githubRepoRef: data.githubRepoRef,
      maintainers: [creatorContributorId],
      adoptionAuthority: 'maintainers',
      createdBy: creatorContributorId,
      license: data.license,
      tokenBudgetPerUser: data.tokenBudgetPerUser,
      tokenBudgetPerRoom: data.tokenBudgetPerRoom,
    })
    .returning();

  return NextResponse.json({ room }, { status: 201 });
}
