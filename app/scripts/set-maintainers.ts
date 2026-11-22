// Bootstraps a room's maintainer roster from the command line, for the
// case the API route cannot cover: nobody with a real GitHub identity is
// on the seeded room's roster yet, so nobody is authorized to add anyone.
//
// Run with:
//   npm run room:maintainers -- <contributorId> [roomId] [--replace]
//
// Default behaviour adds the contributor to the existing roster. --replace
// sets the roster to exactly that one contributor. A room is never left
// with an empty roster.

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { rooms, contributors } from '../src/db/schema';

const DEFAULT_ROOM_ID = 'night-market';

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const positional = args.filter((a) => !a.startsWith('--'));
  const contributorId = positional[0];
  const roomId = positional[1] ?? DEFAULT_ROOM_ID;

  if (!contributorId) {
    throw new Error('usage: npm run room:maintainers -- <contributorId> [roomId] [--replace]');
  }

  const [contributor] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);
  if (!contributor) {
    throw new Error(`unknown contributor: ${contributorId}`);
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) {
    throw new Error(`unknown room: ${roomId}`);
  }

  const next = replace
    ? [contributorId]
    : room.maintainers.includes(contributorId)
      ? room.maintainers
      : [...room.maintainers, contributorId];

  const [updated] = await db
    .update(rooms)
    .set({ maintainers: next })
    .where(eq(rooms.id, roomId))
    .returning();

  console.log(`room ${roomId} maintainers: ${updated.maintainers.join(', ')}`);
  console.log(`(${contributor.displayName} can now adopt in this room)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
