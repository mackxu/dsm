import { describe, expect, it } from 'vitest';

import {
  canTransition,
  createTaskSnapshot,
  recoveryActionFor,
  transitionTask,
} from '@dsm/core';

describe('task state', () => {
  it('allows the normal upload/download/extract sequence', () => {
    let snapshot = createTaskSnapshot('task', 'a.txt', '/tmp/a.txt');
    snapshot = transitionTask(snapshot, 'UPLOADING');
    snapshot = transitionTask(snapshot, 'UPLOADED');
    snapshot = transitionTask(snapshot, 'DOWNLOADING');
    snapshot = transitionTask(snapshot, 'EXTRACTING');
    snapshot = transitionTask(snapshot, 'CLEANING');
    snapshot = transitionTask(snapshot, 'SUCCESS');

    expect(snapshot.status).toBe('SUCCESS');
    expect(canTransition('SUCCESS', 'CHECKING')).toBe(false);
  });

  it('does not report success before uploading', () => {
    expect(canTransition('CHECKING', 'SUCCESS')).toBe(false);
  });

  it('maps failures to recovery actions', () => {
    expect(
      recoveryActionFor({
        code: 'UPLOAD_RESULT_UNKNOWN',
        stage: 'COMMIT_LOOKUP',
        message: 'unknown',
        recoverable: true,
      }),
    ).toBe('QUERY_COMMIT');
    expect(
      recoveryActionFor({
        code: 'ARCHIVE_DOWNLOAD_FAILED',
        stage: 'DOWNLOAD',
        message: 'failed',
        recoverable: false,
      }),
    ).toBe('RETRY_DOWNLOAD');
  });
});
