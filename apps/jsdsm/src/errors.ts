export type JsdsmErrorCode =
  | 'USAGE_ERROR'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_FILE'
  | 'SOURCE_UNREADABLE'
  | 'SOURCE_CHANGED'
  | 'OUTPUT_DIRECTORY_INVALID'
  | 'WRITER_UNAVAILABLE'
  | 'WRITE_FAILED'
  | 'WRITE_VERIFY_FAILED'
  | 'NAME_EXHAUSTED'
  | 'PUBLISH_FAILED'
  | 'CANCELLED'
  | 'IO_FAILED';

export class JsdsmError extends Error {
  constructor(
    readonly code: JsdsmErrorCode,
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'JsdsmError';
  }
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR';
}

export function mapSourceError(error: unknown, sourcePath: string): JsdsmError {
  const code = errorCode(error);
  switch (code) {
    case 'ENOENT':
      return new JsdsmError(
        'SOURCE_NOT_FOUND',
        `源文件不存在：${sourcePath}`,
        error,
      );
    case 'EACCES':
    case 'EPERM':
      return new JsdsmError(
        'SOURCE_UNREADABLE',
        `没有权限读取源文件：${sourcePath}`,
        error,
      );
    case 'ELOOP':
      return new JsdsmError(
        'SOURCE_UNREADABLE',
        `无法访问源文件（符号链接层次过多）：${sourcePath}`,
        error,
      );
    case 'ENAMETOOLONG':
      return new JsdsmError(
        'SOURCE_UNREADABLE',
        `源文件路径过长：${sourcePath}`,
        error,
      );
    default:
      return new JsdsmError(
        'SOURCE_UNREADABLE',
        `无法读取源文件：${sourcePath}（${errorMessage(error)}）`,
        error,
      );
  }
}

export function mapOutputDirectoryError(
  error: unknown,
  directory: string,
): JsdsmError {
  const code = errorCode(error);
  switch (code) {
    case 'EEXIST':
    case 'ENOTDIR':
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `输出路径不是目录：${directory}`,
        error,
      );
    case 'EACCES':
    case 'EPERM':
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `没有权限创建或写入输出目录：${directory}`,
        error,
      );
    case 'EROFS':
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `输出目录位于只读文件系统：${directory}`,
        error,
      );
    case 'ENOSPC':
    case 'EDQUOT':
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `磁盘空间不足，无法准备输出目录：${directory}`,
        error,
      );
    case 'ENAMETOOLONG':
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `输出目录路径过长：${directory}`,
        error,
      );
    default:
      return new JsdsmError(
        'OUTPUT_DIRECTORY_INVALID',
        `无法准备输出目录：${directory}（${errorMessage(error)}）`,
        error,
      );
  }
}

export function mapOutputError(error: unknown, target: string): JsdsmError {
  const code = errorCode(error);
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return new JsdsmError(
        'WRITE_FAILED',
        `磁盘空间不足，写入未完成：${target}`,
        error,
      );
    case 'EACCES':
    case 'EPERM':
      return new JsdsmError(
        'WRITE_FAILED',
        `没有权限写入输出目录：${target}`,
        error,
      );
    case 'EROFS':
      return new JsdsmError(
        'WRITE_FAILED',
        `输出目录位于只读文件系统：${target}`,
        error,
      );
    case 'EMFILE':
    case 'ENFILE':
      return new JsdsmError('WRITE_FAILED', '打开文件过多，请稍后重试', error);
    case 'ENAMETOOLONG':
      return new JsdsmError('WRITE_FAILED', `文件名过长：${target}`, error);
    default:
      return new JsdsmError(
        'WRITE_FAILED',
        `写入失败：${errorMessage(error)}（${code ?? '未知错误'}）`,
        error,
      );
  }
}

export function mapPublishError(error: unknown, target: string): JsdsmError {
  const code = errorCode(error);
  switch (code) {
    case 'ENOENT':
      return new JsdsmError(
        'PUBLISH_FAILED',
        `输出目录或临时文件在复制过程中被删除：${target}`,
        error,
      );
    case 'EPERM':
    case 'EBUSY':
      return new JsdsmError(
        'PUBLISH_FAILED',
        `无法替换目标文件（可能被占用或只读）：${target}`,
        error,
      );
    case 'EXDEV':
      return new JsdsmError(
        'PUBLISH_FAILED',
        '临时文件与目标不在同一文件系统，无法原子重命名',
        error,
      );
    case 'EROFS':
      return new JsdsmError(
        'PUBLISH_FAILED',
        `输出目录位于只读文件系统：${target}`,
        error,
      );
    case 'ENOSPC':
    case 'EDQUOT':
      return new JsdsmError(
        'PUBLISH_FAILED',
        `磁盘空间不足，无法完成重命名：${target}`,
        error,
      );
    case 'EACCES':
      return new JsdsmError(
        'PUBLISH_FAILED',
        `没有权限写入输出目录：${target}`,
        error,
      );
    case 'ENAMETOOLONG':
      return new JsdsmError('PUBLISH_FAILED', `文件名过长：${target}`, error);
    default:
      return new JsdsmError(
        'PUBLISH_FAILED',
        `发布文件失败：${errorMessage(error)}（${code ?? '未知错误'}）`,
        error,
      );
  }
}
