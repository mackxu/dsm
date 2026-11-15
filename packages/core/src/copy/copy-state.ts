import type { DsmErrorCode, TaskStage } from '../errors.ts';

export type CopyStatus =
  | 'IDLE'
  | 'CHECKING'
  | 'COPYING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'FAILED';

export type CopyStage = Extract<
  TaskStage,
  'CHECK' | 'COPY' | 'VERIFY' | 'CLEANUP'
>;

export type CopyRecoveryAction = 'RETRY_COPY';

export interface CopyFailure {
  code: DsmErrorCode;
  stage: TaskStage;
  message: string;
  recoverable: boolean;
}

export interface CopySnapshot {
  taskId: string;
  status: CopyStatus;
  stage: CopyStage | null;
  fileName: string | null;
  sourcePath: string | null;
  targetDirectory: string | null;
  targetPath: string | null;
  bytesProcessed: number;
  bytesRead: number;
  bytesWritten: number;
  startedAt: string;
  updatedAt: string;
  failure: CopyFailure | null;
  recoveryActions: CopyRecoveryAction[];
}

const TRANSITIONS: Record<CopyStatus, ReadonlySet<CopyStatus>> = {
  IDLE: new Set(['CHECKING', 'FAILED']),
  CHECKING: new Set(['COPYING', 'FAILED']),
  COPYING: new Set(['VERIFYING', 'FAILED']),
  VERIFYING: new Set(['SUCCESS', 'FAILED']),
  SUCCESS: new Set([]),
  FAILED: new Set(['CHECKING']),
};

export const ACTIVE_COPY_STATUSES: ReadonlySet<CopyStatus> = new Set([
  'CHECKING',
  'COPYING',
  'VERIFYING',
]);

export function canTransitionCopy(from: CopyStatus, to: CopyStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function transitionCopy(
  snapshot: CopySnapshot,
  status: CopyStatus,
  now = new Date(),
): CopySnapshot {
  if (
    snapshot.status !== status &&
    !canTransitionCopy(snapshot.status, status)
  ) {
    throw new Error(`Invalid copy transition: ${snapshot.status} -> ${status}`);
  }
  return {
    ...snapshot,
    status,
    updatedAt: now.toISOString(),
  };
}

export function createCopySnapshot(
  taskId: string,
  fileName: string | null,
  sourcePath: string | null,
  now = new Date(),
): CopySnapshot {
  const timestamp = now.toISOString();
  return {
    taskId,
    status: 'CHECKING',
    stage: 'CHECK',
    fileName,
    sourcePath,
    targetDirectory: null,
    targetPath: null,
    bytesProcessed: 0,
    bytesRead: 0,
    bytesWritten: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    failure: null,
    recoveryActions: [],
  };
}

export function recoveryActionForCopy(
  failure: CopyFailure,
): CopyRecoveryAction | null {
  return failure.stage === 'CONFIG' ? null : 'RETRY_COPY';
}
