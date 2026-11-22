import Link from 'next/link';
import { AuthProfile } from './AuthProfile';
import { BrandMark } from './BrandMark';

export interface RailRoomSummary {
  id: string;
  name: string;
}

export interface LeftRailProps {
  rooms: RailRoomSummary[];
  activeRoomId: string;
  proposalCount: number;
  currentUser: { id: string; displayName: string } | null;
}

export function LeftRail({ rooms, activeRoomId, proposalCount, currentUser }: LeftRailProps) {
  return (
    <nav className="rail" id="app-rail">
      <div className="rail-brand">
        <BrandMark className="mark" />
        <span className="word">Agent Rooms</span>
        <span className="spacer" />
      </div>

      {/* No search, no New room button: neither exists as a feature (rooms
          are created ahead of a jam by the organizer via `npm run
          room:repo`), and a control that cannot act does not render at all.
          Testers click what they see; what they see must respond. */}

      <div className="rail-scroll">
        <div className="rail-section">Rooms</div>
        {rooms.map((room) => (
          <Link key={room.id} href={`/room/${room.id}`} className={`rail-item${room.id === activeRoomId ? ' active' : ''}`}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M2 6.5h12" />
            </svg>
            {room.name}
            {room.id === activeRoomId && <span className="count">{proposalCount}</span>}
          </Link>
        ))}

        <div className="rail-section">This room</div>
        {/* Only Proposals renders: it is the room feed, a real destination.
            Canonical build, timeline, and members views do not exist yet, so
            they do not appear at all rather than sitting inert in the rail. */}
        <Link href={`/room/${activeRoomId}`} className="rail-item active">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <path d="M5.5 6h5M5.5 9h3.5" />
          </svg>
          Proposals
          <span className="count">{proposalCount}</span>
        </Link>
      </div>

      <div className="rail-foot">
        <div className="rail-profile">
          <AuthProfile currentUser={currentUser} />
        </div>
      </div>
    </nav>
  );
}
