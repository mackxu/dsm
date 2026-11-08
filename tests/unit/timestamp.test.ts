import { describe, expect, it } from 'vitest';

import { createUtc8Timestamp } from '@dsm/core';

describe('UTC+8 task timestamps', () => {
  it('formats the UTC+8 wall clock time', () => {
    expect(
      createUtc8Timestamp(new Date('2026-11-08T07:30:00.123Z')),
    ).toBe('20261108-153000-123');
  });

  it('crosses the day boundary in UTC+8', () => {
    expect(
      createUtc8Timestamp(new Date('2026-11-07T20:00:00.000Z')),
    ).toBe('20261108-040000-000');
  });

  it('does not depend on the process timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(
        createUtc8Timestamp(new Date('2026-01-01T00:00:00.000Z')),
      ).toBe('20260101-080000-000');
      process.env.TZ = 'Asia/Shanghai';
      expect(
        createUtc8Timestamp(new Date('2026-01-01T00:00:00.000Z')),
      ).toBe('20260101-080000-000');
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });
});
