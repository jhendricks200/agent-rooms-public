import { NextRequest, NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages, rooms, contributors } from '@/db/schema';
import { createMessageSchema } from '@/lib/validation';
import { generateId } from '@/lib/ids';
import { getCurrentContributorId } from '@/lib/session';
import { rateLimitResponse } from '@/lib/rateLimit';

// Plain chat messages on the room's group stream. Not part of the design
// doc's Entities section (that section only covers the promote/fork/adopt
// loop); added so the group chat shown interleaved with proposal cards is
// backed by real rows instead of static markup.

// Reads are authenticated: a room's chat stream is not public. The
// development identity fallback in lib/session.ts still applies, so local
// verify scripts are unaffected.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const readerContributorId = await getCurrentContributorId();
  if (!readerContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await params;

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, id))
    .orderBy(asc(messages.createdAt));

  return NextResponse.json({ messages: rows });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authorContributorId = await getCurrentContributorId();
  if (!authorContributorId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await rateLimitResponse(authorContributorId, 'message.post');
  if (limited) return limited;

  const { id } = await params;
  const body = await request.json();
  const parsed = createMessageSchema.safeParse({ ...body, roomId: id });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  if (!room) {
    return NextResponse.json({ error: 'room not found' }, { status: 404 });
  }

  const data = parsed.data;

  const [author] = await db
    .select({ id: contributors.id })
    .from(contributors)
    .where(eq(contributors.id, authorContributorId))
    .limit(1);
  if (!author) {
    return NextResponse.json({ error: `unknown contributor: ${authorContributorId}` }, { status: 400 });
  }

  const messageId = generateId('message');

  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      roomId: data.roomId,
      authorContributorId,
      body: data.body,
    })
    .returning();

  return NextResponse.json({ message }, { status: 201 });
}
