import { avatarClass, initials, pluralize } from '@/lib/ui';
import { ThemeToggle } from './ThemeToggle';
import { AgentPaneToggle } from './AgentPaneToggle';
import { RailToggle } from './RailToggle';

export interface RoomHeaderMember {
  id: string;
  displayName: string;
  away?: boolean;
}

export interface RoomHeaderProps {
  name: string;
  tagline: string;
  members: RoomHeaderMember[];
  onlineCount: number;
}

export function RoomHeader({ name, tagline, members, onlineCount }: RoomHeaderProps) {
  return (
    <header className="room-header">
      {/* Only visible below the rail breakpoint; see globals.css. */}
      <RailToggle />
      <div className="room-title">
        <h1>
          {name} <span className="room-kind">room · {pluralize(members.length, 'builder')}</span>
        </h1>
        <div className="room-line">{tagline}</div>
      </div>
      <div className="header-spacer" />
      <div className="members" title={members.map((m) => m.displayName).join(', ')}>
        {members.map((member) => (
          <div key={member.id} className={`avatar ${avatarClass(member.id)}`}>
            {initials(member.displayName)}
            <span className={`presence${member.away ? ' away' : ''}`} />
          </div>
        ))}
      </div>
      <span className="members-count">{onlineCount} in the lab</span>
      <AgentPaneToggle />
      <ThemeToggle />
    </header>
  );
}
