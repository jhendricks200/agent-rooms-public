import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { rooms } from "@/db/schema";

// The seeded demonstration room. ADR 0003 and docs/design/promote-provenance.md
// both require that the first person to open the app land in a room where the
// promote/fork/remix/adopt loop has already happened, and it is the first thing a new participant sees.
// So this room is named explicitly rather than left to whichever row Postgres
// happened to return first: an unordered limit(1) could just as easily drop a
// tester into the Stage 0 lab or a leftover test room.
const DEMO_ROOM_ID = "night-market";

export default async function Home() {
  const [demo] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, DEMO_ROOM_ID))
    .limit(1);

  if (demo) {
    redirect(`/room/${demo.id}`);
  }

  // No demo room in this database: fall back to the oldest room, so a
  // development database that was never seeded still opens on something.
  const [oldest] = await db.select({ id: rooms.id }).from(rooms).orderBy(asc(rooms.createdAt)).limit(1);

  if (oldest) {
    redirect(`/room/${oldest.id}`);
  }

  return (
    <main style={{ padding: 40, fontFamily: "var(--font-ui)" }}>
      <h1>Agent Rooms</h1>
      <p>No rooms yet. Run <code>npm run demo:curate</code> to load the seeded demonstration room.</p>
    </main>
  );
}
