import type { DsmErrorCode, TaskStage } from './errors.ts';

export type TaskStatus =
  | 'IDLE'
  | 'CHECKING'
  | 'WAITING_FOR_TOKEN'
  | 'WAITING_FOR_OVERWRITE_CONFIRMATION'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'DOWNLOADING'
  | 'EXTRACTING'
  | 'CLEANING'
  | 'SUCCESS'
  | 'SUCCESS_WITH_WARNING'
  | 'FAILED';

export type RecoveryAction =
  | 'CONFIGURE_TOKEN'
  | 'QUERY_COMMIT'
  | 'RETRY_DOWNLOAD'
  | 'RETRY_EXTRACTION'
  | 'RETRY_CLEANUP';

export interface TaskFailure {
  code: DsmErrorCode;
  stage: TaskStage;
  message: string;
  recoverable: boolean;
}

export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  stage: TaskStage | null;
  fileName: string | null;
  localFilePath: string | null;
  branch: string | null;
  remotePath: string | null;
  sourceBranch: string | null;
  branchCreated: boolean;
  commitId: string | null;
  archivePath: string | null;
  resultDirectory: string | null;
  startedAt: string;
  updatedAt: string;
  failure: TaskFailure | null;
  warning: string | null;
  recoveryActions: RecoveryAction[];
}

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  IDLE: new Set(['CHECKING', 'FAILED']),
  CHECKING: new Set([
    'WAITING_FOR_TOKEN',
    'WAITING_FOR_OVERWRITE_CONFIRMATION',
    'UPLOADING',
    'FAILED',
  ]),
  WAITING_FOR_TOKEN: new Set(['CHECKING', 'FAILED']),
  WAITING_FOR_OVERWRITE_CONFIRMATION: new Set(['CHECKING', 'UPLOADING', 'FAILED']),
  UPLOADING: new Set(['UPLOADED', 'FAILED']),
  UPLOADED: new Set(['DOWNLOADING', 'FAILED']),
  DOWNLOADING: new Set(['EXTRACTING', 'FAILED']),
  EXTRACTING: new Set(['CLEANING', 'FAILED']),
  CLEANING: new Set(['SUCCESS', 'SUCCESS_WITH_WARNING', 'FAILED']),
  SUCCESS: new Set([]),
  SUCCESS_WITH_WARNING: new Set([]),
  FAILED: new Set(['CHECKING', 'DOWNLOADING', 'EXTRACTING', 'CLEANING']),
};

export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'CHECKING',
  'WAITING_FOR_TOKEN',
  'WAITING_FOR_OVERWRITE_CONFIRMATION',
  'UPLOADING',
  'UPLOADED',
  'DOWNLOADING',
  'EXTRACTING',
  'CLEANING',
]);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function transitionTask(
  snapshot: TaskSnapshot,
  status: TaskStatus,
  now = new Date(),
): TaskSnapshot {
  if (snapshot.status !== status && !canTransition(snapshot.status, status)) {
    throw new Error(`Invalid task transition: ${snapshot.status} -> ${status}`);
  }
  return {
    ...snapshot,
    status,
    updatedAt: now.toISOString(),
  };
}

export function recoveryActionFor(failure: TaskFailure): RecoveryAction | null {
  if (
    failure.code === 'TOKEN_MISSING' ||
    failure.code === 'AUTHENTICATION_FAILED' ||
    failure.code === 'PERMISSION_DENIED'
  ) {
    return 'CONFIGURE_TOKEN';
  }
  if (failure.code === 'UPLOAD_RESULT_UNKNOWN') {
    return 'QUERY_COMMIT';
  }
  if (failure.stage === 'DOWNLOAD') {
    return 'RETRY_DOWNLOAD';
  }
  if (failure.stage === 'EXTRACT') {
    return 'RETRY_EXTRACTION';
  }
  if (failure.stage === 'CLEANUP') {
    return 'RETRY_CLEANUP';
  }
  return null;
}

export function createTaskSnapshot(
  taskId: string,
  fileName: string | null,
  localFilePath: string | null,
  now = new Date(),
): TaskSnapshot {
  const timestamp = now.toISOString();
  return {
    taskId,
    status: 'CHECKING',
    stage: 'CHECK',
    fileName,
    localFilePath,
    branch: null,
    remotePath: null,
    sourceBranch: null,
    branchCreated: false,
    commitId: null,
    archivePath: null,
    resultDirectory: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    failure: null,
    warning: null,
    recoveryActions: [],
  };
}
