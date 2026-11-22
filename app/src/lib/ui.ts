// Small presentational helpers shared by the room and proposal pages.
// Not part of the domain model in src/lib - purely UI formatting.

const AVATAR_CLASSES = ['a-priya', 'a-dele', 'a-mara', 'a-tomas', 'a-sana'];

/**
 * Deterministic avatar color class for a contributor id, cycling through
 * the five palette slots defined in the design system. Falls back to
 * a-default (see globals.css) once a room has more than five people.
 */
export function avatarClass(contributorId: string): string {
  let hash = 0;
  for (let i = 0; i < contributorId.length; i++) {
    hash = (hash * 31 + contributorId.charCodeAt(i)) >>> 0;
  }
  return AVATAR_CLASSES[hash % AVATAR_CLASSES.length];
}

export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Compact relative time: "now", "2m", "1h", "3h", "yesterday", "2d",
 * matching the comp's timestamp style (design/direction-c2.html).
 */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 45) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return 'yesterday';
  return `${diffDay}d`;
}

export function shortHash(hash: string, length = 7): string {
  return hash.slice(0, length);
}

/** Rooms created by a script get an opaque `room_<uuid>` id rather than a slug. */
const UUID_IN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The `#channel` name shown in the feed heading and the composer
 * placeholder. A room whose id is a human slug uses it as-is; a room
 * created without one would otherwise render a raw UUID at both places,
 * so its display name is slugified instead. Purely cosmetic: every link
 * and API call still uses `room.id`.
 */
export function roomChannelName(roomId: string, roomName: string): string {
  if (!UUID_IN_ID.test(roomId)) return roomId;
  const slug = roomName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'room';
}

/** "1 builder", "2 builders" - the header used to say "1 builders". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
