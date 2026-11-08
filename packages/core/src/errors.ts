export type TaskStage =
  | 'CHECK'
  | 'UPLOAD'
  | 'COMMIT_LOOKUP'
  | 'DOWNLOAD'
  | 'EXTRACT'
  | 'CLEANUP'
  | 'CONFIG';

export type DsmErrorCode =
  | 'CONFIG_REQUIRED'
  | 'CONFIG_INVALID'
  | 'TOKEN_MISSING'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'FILE_INVALID'
  | 'FILE_TOO_LARGE'
  | 'FILE_CHANGED'
  | 'FILE_READ_FAILED'
  | 'READER_UNAVAILABLE'
  | 'SAVE_DIRECTORY_UNAVAILABLE'
  | 'OVERWRITE_CONFIRMATION_REQUIRED'
  | 'BRANCH_CREATE_FAILED'
  | 'UPLOAD_RESULT_UNKNOWN'
  | 'ARCHIVE_DOWNLOAD_FAILED'
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_TOO_LARGE'
  | 'EXTRACTION_FAILED'
  | 'CLEANUP_FAILED'
  | 'TASK_BUSY'
  | 'TASK_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'NETWORK_ERROR';

export class DsmError extends Error {
  constructor(
    readonly code: DsmErrorCode,
    message: string,
    readonly stage: TaskStage,
    readonly recoverable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DsmError';
  }
}

export function asDsmError(
  error: unknown,
  stage: TaskStage,
  fallbackCode: DsmErrorCode = 'NETWORK_ERROR',
): DsmError {
  if (error instanceof DsmError) {
    return error;
  }

  return new DsmError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    stage,
  );
}

export function authErrorCode(status: number): DsmErrorCode {
  return status === 401 ? 'AUTHENTICATION_FAILED' : 'PERMISSION_DENIED';
}
