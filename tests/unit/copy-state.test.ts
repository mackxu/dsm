import { describe, expect, it } from 'vitest';

import {
  ACTIVE_COPY_STATUSES,
  createCopySnapshot,
  recoveryActionForCopy,
  transitionCopy,
} from '@dsm/core';

describe('copy state', () => {
  it('creates an initial checking snapshot', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const snapshot = createCopySnapshot('abcdef12', 'a.txt', '/tmp/a.txt', now);
    expect(snapshot.status).toBe('CHECKING');
    expect(snapshot.stage).toBe('CHECK');
    expect(snapshot.targetDirectory).toBeNull();
    expect(snapshot.targetPath).toBeNull();
    expect(snapshot.bytesProcessed).toBe(0);
    expect(snapshot.startedAt).toBe(now.toISOString());
    expect(snapshot.recoveryActions).toEqual([]);
  });

  it('allows the copy lifecycle and rejects invalid jumps', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    let snapshot = createCopySnapshot('abcdef12', 'a.txt', '/tmp/a.txt', now);

    snapshot = transitionCopy(snapshot, 'COPYING', now);
    snapshot = transitionCopy(snapshot, 'VERIFYING', now);
    snapshot = transitionCopy(snapshot, 'SUCCESS', now);
    expect(snapshot.status).toBe('SUCCESS');

    const failed = transitionCopy(
      createCopySnapshot('abcdef12', 'a.txt', '/tmp/a.txt', now),
      'FAILED',
      now,
    );
    expect(failed.status).toBe('FAILED');
    expect(() => transitionCopy(failed, 'SUCCESS', now)).toThrowError(
      'Invalid copy transition: FAILED -> SUCCESS',
    );
  });

  it('tracks active statuses', () => {
    expect([...ACTIVE_COPY_STATUSES].sort()).toEqual([
      'CHECKING',
      'COPYING',
      'VERIFYING',
    ]);
  });

  it('offers retry unless the failure is a configuration error', () => {
    expect(
      recoveryActionForCopy({
        code: 'WRITE_FAILED',
        stage: 'COPY',
        message: 'x',
        recoverable: true,
      }),
    ).toBe('RETRY_COPY');
    expect(
      recoveryActionForCopy({
        code: 'CONFIG_INVALID',
        stage: 'CONFIG',
        message: 'x',
        recoverable: false,
      }),
    ).toBeNull();
  });
});
