import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  JsdsmError,
  errorCode,
  isAbortError,
  mapOutputDirectoryError,
  mapOutputError,
  mapPublishError,
  mapSourceError,
} from './errors.ts';
import { MAX_NAME_ATTEMPTS, candidateName } from './naming.ts';
import type { WriteResult, WriteSession, WriterLike } from './writer.ts';

export interface CopyDependencies {
  createReadStream?: (filePath: string) => Readable;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export interface CopyOptions {
  writer: WriterLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxNameAttempts?: number;
  deps?: CopyDependencies;
  onProgress?: (progress: CopyProgress) => void;
}

export type CopyProgress =
  | { phase: 'reading' }
  | { phase: 'writing' }
  | { phase: 'progress'; bytes: number }
  | { phase: 'verifying' };

export interface CopyResult {
  sourcePath: string;
  targetPath: string;
  bytes: number;
  renamed: boolean;
}

const PROGRESS_INTERVAL_MS = 500;
const PROGRESS_STEP_BYTES = 10 * 1024 * 1024;

/**
 * 由当前 Node 读取源文件，把明文字节交给 PowerShell 写入目标目录下的
 * .part 临时文件，校验字节数与 SHA-256 后再 rename 为最终文件。
 *
 * 目标同名文件不覆盖：先用 O_EXCL 占位，再 rename 覆盖自己创建的占位。
 */
export async function copyViaPowerShell(
  sourcePath: string,
  outputDirectory: string,
  options: CopyOptions,
): Promise<CopyResult> {
  throwIfAborted(options.signal);

  const before = await fs.stat(sourcePath).catch((error: unknown) => {
    throw mapSourceError(error, sourcePath);
  });
  if (!before.isFile()) {
    throw new JsdsmError(
      'SOURCE_NOT_FILE',
      `源路径不是普通文件：${sourcePath}`,
    );
  }
  await fs.access(sourcePath, constants.R_OK).catch((error: unknown) => {
    throw mapSourceError(error, sourcePath);
  });

  await fs
    .mkdir(outputDirectory, { recursive: true })
    .catch((error: unknown) => {
      throw mapOutputDirectoryError(error, outputDirectory);
    });
  const outputStat = await fs.stat(outputDirectory).catch((error: unknown) => {
    throw mapOutputDirectoryError(error, outputDirectory);
  });
  if (!outputStat.isDirectory()) {
    throw new JsdsmError(
      'OUTPUT_DIRECTORY_INVALID',
      `输出路径不是目录：${outputDirectory}`,
    );
  }
  await fs.access(outputDirectory, constants.W_OK).catch((error: unknown) => {
    throw mapOutputDirectoryError(error, outputDirectory);
  });

  const baseName = path.basename(sourcePath);
  const tempName = `.jsdsm-${process.pid}-${randomUUID()}.part`;
  const tempPath = path.join(outputDirectory, tempName);
  const maxNameAttempts = options.maxNameAttempts ?? MAX_NAME_ATTEMPTS;
  let session: WriteSession | null = null;
  let reservedPath: string | null = null;
  let committedPath: string | null = null;
  let readError: unknown = null;

  try {
    throwIfAborted(options.signal);
    session = await options.writer.open(outputDirectory, baseName, tempName, {
      timeoutMs: options.timeoutMs,
    });
    emitProgress(options, { phase: 'reading' });
    emitProgress(options, { phase: 'writing' });

    const hash = createHash('sha256');
    let bytes = 0;
    let reportedBytes = 0;
    let lastProgressAt = Date.now();
    let lastProgressBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        if (
          now - lastProgressAt >= PROGRESS_INTERVAL_MS ||
          bytes - lastProgressBytes >= PROGRESS_STEP_BYTES
        ) {
          lastProgressAt = now;
          lastProgressBytes = bytes;
          reportedBytes = bytes;
          emitProgress(options, { phase: 'progress', bytes });
        }
        callback(null, chunk);
      },
    });

    const openReadStream = options.deps?.createReadStream ?? createReadStream;
    const readStream = openReadStream(sourcePath);
    readStream.once('error', (error: unknown) => {
      if (isSourceReadErrorCode(errorCode(error))) {
        readError = error;
      }
    });
    const onAbort = (): void => session?.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let writeResult: WriteResult;
    try {
      const pipePromise = pipeline(readStream, meter, session.stdin, {
        signal: options.signal,
      });
      [writeResult] = await Promise.all([session.completed, pipePromise]);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (reportedBytes > 0 && bytes > reportedBytes) {
      emitProgress(options, { phase: 'progress', bytes });
    }
    emitProgress(options, { phase: 'verifying' });

    const sha256 = hash.digest('hex');
    if (writeResult.bytesWritten !== bytes) {
      throw new JsdsmError(
        'WRITE_VERIFY_FAILED',
        `写入校验失败：读取 ${bytes} 字节，写入组件报告 ${writeResult.bytesWritten} 字节。`,
      );
    }
    if (writeResult.sha256 !== sha256) {
      throw new JsdsmError('WRITE_VERIFY_FAILED', '写入内容校验失败，请重试。');
    }

    const tempStat = await fs
      .stat(writeResult.tempPath)
      .catch((error: unknown) => {
        throw mapOutputError(error, writeResult.tempPath);
      });
    if (!tempStat.isFile() || tempStat.size !== writeResult.bytesWritten) {
      throw new JsdsmError('WRITE_VERIFY_FAILED', '写入结果不完整，请重试。');
    }

    const after = await fs.stat(sourcePath).catch(() => null);
    if (
      !after?.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new JsdsmError(
        'SOURCE_CHANGED',
        '源文件在读取过程中发生变化，已取消并清理未完成文件',
      );
    }

    throwIfAborted(options.signal);
    reservedPath = await reserveAndRename(
      writeResult.tempPath,
      outputDirectory,
      baseName,
      maxNameAttempts,
      options.deps?.rename ?? fs.rename,
    );
    committedPath = reservedPath;

    return {
      sourcePath,
      targetPath: committedPath,
      bytes,
      renamed: path.basename(committedPath) !== baseName,
    };
  } catch (error) {
    if (
      isAbortError(error) ||
      (error instanceof JsdsmError && error.code === 'CANCELLED')
    ) {
      throw new JsdsmError('CANCELLED', '操作已取消', error);
    }
    if (readError !== null) {
      throw mapSourceError(readError, sourcePath);
    }
    if (error instanceof JsdsmError) {
      throw error;
    }
    throw mapOutputError(error, tempPath);
  } finally {
    session?.abort();
    if (committedPath === null) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    if (reservedPath !== null && reservedPath !== committedPath) {
      await fs.rm(reservedPath, { force: true }).catch(() => {});
    }
  }
}

async function reserveAndRename(
  tempPath: string,
  directory: string,
  baseName: string,
  maxAttempts: number,
  rename: (oldPath: string, newPath: string) => Promise<void>,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = path.join(directory, candidateName(baseName, attempt));
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(candidate, 'wx', 0o666);
    } catch (error) {
      if (isOccupiedError(error)) {
        continue;
      }
      throw mapPublishError(error, candidate);
    } finally {
      await handle?.close().catch(() => {});
    }

    try {
      await rename(tempPath, candidate);
      return candidate;
    } catch (error) {
      await fs.rm(candidate, { force: true }).catch(() => {});
      throw mapPublishError(error, candidate);
    }
  }

  throw new JsdsmError(
    'NAME_EXHAUSTED',
    `已尝试 ${maxAttempts} 个文件名仍无法避免重名，请清理输出目录后重试`,
  );
}

function isOccupiedError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EEXIST' || code === 'EISDIR';
}

const SOURCE_READ_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ELOOP',
  'EISDIR',
  'EIO',
  'EBUSY',
  'ETIMEDOUT',
  'ENAMETOOLONG',
  'ENODEV',
  'ENXIO',
  'EMFILE',
  'ENFILE',
]);

function isSourceReadErrorCode(code: string | undefined): boolean {
  return code !== undefined && SOURCE_READ_ERROR_CODES.has(code);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new JsdsmError('CANCELLED', '操作已取消');
  }
}

function emitProgress(options: CopyOptions, progress: CopyProgress): void {
  try {
    options.onProgress?.(progress);
  } catch {
    // 进度输出失败不应中断复制。
  }
}
