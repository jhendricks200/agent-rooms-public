import Link from 'next/link';
import { connection } from 'next/server';
import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { rooms } from '@/db/schema';
import { getCurrentContributorId } from '@/lib/session';
import { BrandMark } from '@/components/BrandMark';

// The root not-found handles both a `notFound()` thrown by the room and
// proposal pages and any URL the app does not route at all. Before this,
// both produced the stock Next.js 404: a black page with no header, no
// rail and no way back into the app, which is not a state a stranger
// should be able to reach from a mistyped link.
//
// Rendered inside the app shell's visual language rather than the shell
// itself: there is no room to draw a room header or a room's environment
// panel for, so the page offers the one thing that is actually useful,
// the way back to the rooms this person can open.

export default async function NotFound() {
  // Excludes this page from prerendering: it reads the session and the
  // rooms table, both of which are request-time. See
  // node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md
  await connection();

  let openRooms: { id: string; name: string }[] = [];
  let signedIn = false;
  try {
    signedIn = (await getCurrentContributorId()) != null;
    if (signedIn) {
      openRooms = await db
        .select({ id: rooms.id, name: rooms.name })
        .from(rooms)
        .orderBy(asc(rooms.createdAt))
        .limit(6);
    }
  } catch {
    // The rooms list is a convenience. If the database is unreachable the
    // page still has to render, because this is the error page.
  }

  return (
    <div className="notfound-page">
      <div className="notfound-panel">
        <div className="notfound-brand">
          <BrandMark className="mark" />
          <span className="word">Agent Rooms</span>
        </div>

        <div className="notfound-code">404</div>
        <h1>There is no room or proposal at this address.</h1>
        <p>
          The link may be mistyped, or it may point at something that was never created in this instance. Nothing has
          gone wrong with your session.
        </p>

        <div className="notfound-actions">
          <Link className="btn-primary" href="/">
            Go to your rooms
          </Link>
        </div>

        {openRooms.length > 0 && (
          <div className="notfound-rooms">
            <div className="notfound-rooms-head">Rooms you can open</div>
            {openRooms.map((room) => (
              <Link key={room.id} href={`/room/${room.id}`} className="notfound-room">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="2" y="3" width="12" height="10" rx="2" />
                  <path d="M2 6.5h12" />
                </svg>
                {room.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
