import { describe, expect, it } from 'vitest';
import { pluralize, roomChannelName } from '../ui';

describe('roomChannelName', () => {
  it('keeps a human slug id as the channel name', () => {
    expect(roomChannelName('night-market', 'Night Market (demo)')).toBe('night-market');
    expect(roomChannelName('stage0-lab', 'Stage 0 Lab')).toBe('stage0-lab');
  });

  it('slugifies the display name when the id is a generated uuid', () => {
    expect(roomChannelName('room_test_c1013144-91af-4599-ae08-2ff5bb6ca61f', 'Test Room')).toBe('test-room');
    expect(roomChannelName('room_e95a04d8-8b72-475e-a678-3b626ca050c4', 'Nightmarket Verify')).toBe(
      'nightmarket-verify',
    );
  });

  it('falls back to "room" when the name slugifies to nothing', () => {
    expect(roomChannelName('room_e95a04d8-8b72-475e-a678-3b626ca050c4', '  ***  ')).toBe('room');
  });
});

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(0, 'builder')).toBe('0 builders');
    expect(pluralize(1, 'builder')).toBe('1 builder');
    expect(pluralize(2, 'builder')).toBe('2 builders');
  });
});
