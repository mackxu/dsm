import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { resolveSaveDirectory } from '../config.ts';
import { asDsmError, DsmError, type TaskStage } from '../errors.ts';
import type {
  FileReadStream,
  FileStreamReader,
  FileStreamWriter,
  FileWriteSession,
} from '../ports/copy-stream.ts';
import { createUtc8Timestamp } from '../timestamp.ts';
import { validateCopyConfig, type CopyConfig } from './copy-config.ts';
import {
  ACTIVE_COPY_STATUSES,
  createCopySnapshot,
  transitionCopy,
  type CopySnapshot,
  type CopyStage,
  type CopyStatus,
} from './copy-state.ts';

const PROGRESS_STEP_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;

export interface CopyControllerOptions {
  getConfig: () => Promise<CopyConfig>;
  getDocumentsDirectory: () => string;
  openReadStream: FileStreamReader;
  openWriteSession: FileStreamWriter;
  onUpdate?: (snapshot: CopySnapshot) => void;
  now?: () => Date;
  createId?: () => string;
}

interface FileBaseline {
  size: number;
  modifiedAtMs: number;
}

/**
 * 本机直写任务：白名单读取器 stdout → 哈希/限流管道 → PowerShell stdin。
 *
 * 明文只存在于两个子进程之间的管道和主进程内存中，不写临时明文文件。
 * 写入代理只写目标目录下的 `.dsm-copy-<taskId>.part`；本类校验字节数
 * 与 SHA-256 后原子 rename 到最终文件名。
 */
export class CopyController {
  private current: CopySnapshot | null = null;
  private activeReader: FileReadStream | null = null;
  private activeWriter: FileWriteSession | null = null;

  constructor(private readonly options: CopyControllerOptions) {}

  getCurrentTask(): CopySnapshot | null {
    return this.current ? structuredClone(this.current) : null;
  }

  /** 应用退出时终止正在运行的读取/写入子进程。 */
  abort(): void {
    this.activeReader?.abort();
    this.activeWriter?.abort();
  }

  async start(filePath: string): Promise<CopySnapshot> {
    if (this.current && ACTIVE_COPY_STATUSES.has(this.current.status)) {
      throw new DsmError('TASK_BUSY', '已有任务正在运行', 'CHECK');
    }

    const now = this.options.now?.() ?? new Date();
    const taskId = this.options.createId?.() ?? randomUUID();
    const fileName = path.basename(filePath);
    this.current = createCopySnapshot(taskId, fileName, filePath, now);
    this.emit();

    let readerSession: FileReadStream | null = null;
    let writerSession: FileWriteSession | null = null;
    let targetDirectory: string | null = null;
    let tempPath: string | null = null;
    let committedPath: string | null = null;

    try {
      const config = validateCopyConfig(await this.options.getConfig());
      const saveDirectory = resolveSaveDirectory(
        config,
        this.options.getDocumentsDirectory(),
      );
      await this.ensureDirectoryWritable(saveDirectory);
      const baseline = await this.validateFile(filePath, config);

      const directoryName = `${createUtc8Timestamp(now)}-${taskId.slice(0, 6)}`;
      targetDirectory = path.join(saveDirectory, directoryName);
      await fs.mkdir(targetDirectory, { recursive: true });

      const targetPath = path.join(targetDirectory, fileName);
      const tempName = `.dsm-copy-${taskId}.part`;
      tempPath = path.join(targetDirectory, tempName);
      this.patch({ targetDirectory, targetPath });

      this.moveTo('COPYING', 'COPY');
      readerSession = await this.options.openReadStream(filePath, {
        maxBytes: config.maxCopyBytes,
        timeoutMs: config.copyTimeoutMs,
      });
      this.activeReader = readerSession;
      writerSession = await this.options.openWriteSession(
        targetDirectory,
        fileName,
        tempName,
        { timeoutMs: config.copyTimeoutMs },
      );
      this.activeWriter = writerSession;

      const hasher = createHash('sha256');
      let processed = 0;
      let lastProgressBytes = 0;
      let lastProgressAt = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hasher.update(chunk);
          processed += chunk.length;
          const nowMs = Date.now();
          if (
            processed - lastProgressBytes >= PROGRESS_STEP_BYTES ||
            nowMs - lastProgressAt >= PROGRESS_INTERVAL_MS
          ) {
            lastProgressBytes = processed;
            lastProgressAt = nowMs;
            this.patch({ bytesProcessed: processed });
          }
          callback(null, chunk);
        },
      });

      const readerDone = readerSession.completed;
      const writerDone = writerSession.completed;
      const pipeDone = pipeline(
        readerSession.stream,
        meter,
        writerSession.stdin,
      );
      const tasks: Promise<unknown>[] = [readerDone, writerDone, pipeDone];
      for (const task of tasks) {
        // 任一失败时先 abort 对端；这里先挂空 catch，避免其余 promise
        // 在 Promise.all 提前 reject 后产生未处理 rejection。
        task.catch(() => {});
      }
      try {
        await Promise.all(tasks);
      } catch (error) {
        readerSession.abort();
        writerSession.abort();
        throw error;
      }

      const readerBytes = await readerDone;
      const writeResult = await writerDone;
      const sha256 = hasher.digest('hex');

      const afterRead = await fs.stat(filePath).catch(() => null);
      if (
        !afterRead?.isFile() ||
        afterRead.size !== baseline.size ||
        afterRead.mtimeMs !== baseline.modifiedAtMs
      ) {
        throw new DsmError(
          'FILE_CHANGED',
          `读取文件时文件发生变化（原 ${baseline.size} 字节，现 ${afterRead?.size ?? '缺失'} 字节）`,
          'COPY',
        );
      }

      this.patch({
        bytesRead: readerBytes,
        bytesWritten: writeResult.bytesWritten,
        bytesProcessed: processed,
      });

      if (readerBytes !== processed || writeResult.bytesWritten !== processed) {
        throw new DsmError(
          'WRITE_VERIFY_FAILED',
          `字节数不一致：读取 ${readerBytes}，写入 ${writeResult.bytesWritten}，管道 ${processed}`,
          'VERIFY',
        );
      }
      if (sha256 !== writeResult.sha256) {
        throw new DsmError(
          'WRITE_VERIFY_FAILED',
          `写入内容哈希不一致：主进程 ${sha256.slice(0, 16)}…，PowerShell ${writeResult.sha256.slice(0, 16)}…`,
          'VERIFY',
        );
      }

      this.moveTo('VERIFYING', 'VERIFY');
      const tempStat = await fs.stat(writeResult.tempPath).catch(() => null);
      if (!tempStat?.isFile() || tempStat.size !== processed) {
        throw new DsmError(
          'WRITE_VERIFY_FAILED',
          `临时文件大小不一致：预期 ${processed}，实际 ${tempStat?.size ?? '缺失'}`,
          'VERIFY',
        );
      }

      const existingTarget = await fs.stat(targetPath).catch(() => null);
      if (existingTarget) {
        throw new DsmError(
          'WRITE_FAILED',
          `目标文件已存在，未覆盖：${targetPath}`,
          'VERIFY',
        );
      }

      await fs.rename(writeResult.tempPath, targetPath);
      tempPath = null;
      committedPath = targetPath;

      const targetStat = await fs.stat(targetPath).catch(() => null);
      if (!targetStat?.isFile() || targetStat.size !== processed) {
        throw new DsmError(
          'WRITE_VERIFY_FAILED',
          `目标文件校验失败：预期 ${processed}，实际 ${targetStat?.size ?? '缺失'}`,
          'VERIFY',
        );
      }
      committedPath = null;

      if (!this.current) {
        throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
      }
      const finished = transitionCopy(
        this.current,
        'SUCCESS',
        this.options.now?.() ?? new Date(),
      );
      this.current = {
        ...finished,
        stage: 'VERIFY',
        bytesProcessed: processed,
        bytesRead: readerBytes,
        bytesWritten: writeResult.bytesWritten,
        failure: null,
        recoveryActions: [],
      };
      this.emit();
      return this.getCurrentTask() as CopySnapshot;
    } catch (error) {
      readerSession?.abort();
      writerSession?.abort();
      await this.cleanup(tempPath, targetDirectory, committedPath);
      const stage: TaskStage =
        this.current?.stage === 'VERIFY'
          ? 'VERIFY'
          : this.current?.stage === 'COPY'
            ? 'COPY'
            : 'CHECK';
      return this.fail(error, stage);
    } finally {
      this.activeReader = null;
      this.activeWriter = null;
    }
  }

  private async validateFile(
    filePath: string,
    config: CopyConfig,
  ): Promise<FileBaseline> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError('FILE_INVALID', '请选择有效的普通文件', 'CHECK');
    }
    if (stat.size <= 0) {
      throw new DsmError('FILE_INVALID', '不能复制空文件', 'CHECK');
    }
    if (stat.size > config.maxCopyBytes) {
      throw new DsmError('FILE_TOO_LARGE', '文件超过复制大小上限', 'CHECK');
    }
    await fs.access(filePath, fs.constants.R_OK);
    return { size: stat.size, modifiedAtMs: stat.mtimeMs };
  }

  private async ensureDirectoryWritable(directory: string): Promise<void> {
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.access(directory, fs.constants.W_OK);
    } catch (error) {
      throw new DsmError(
        'SAVE_DIRECTORY_UNAVAILABLE',
        `保存目录不可写：${error instanceof Error ? error.message : String(error)}`,
        'CHECK',
      );
    }
  }

  private async cleanup(
    tempPath: string | null,
    targetDirectory: string | null,
    committedPath: string | null,
  ): Promise<void> {
    for (const filePath of [tempPath, committedPath]) {
      if (filePath) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
    }
    if (targetDirectory) {
      await fs.rmdir(targetDirectory).catch(() => {});
    }
  }

  private fail(error: unknown, stage: TaskStage): CopySnapshot {
    const dsmError = asDsmError(error, stage, 'WRITE_FAILED');
    if (!this.current) {
      throw dsmError;
    }
    const snapshotStage: CopyStage =
      stage === 'COPY'
        ? 'COPY'
        : stage === 'VERIFY'
          ? 'VERIFY'
          : stage === 'CLEANUP'
            ? 'CLEANUP'
            : 'CHECK';
    this.current = {
      ...this.current,
      status: 'FAILED',
      stage: snapshotStage,
      failure: {
        code: dsmError.code,
        stage: dsmError.stage,
        message: dsmError.message,
        recoverable: dsmError.recoverable,
      },
      recoveryActions: dsmError.stage === 'CONFIG' ? [] : ['RETRY_COPY'],
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
    return this.getCurrentTask() as CopySnapshot;
  }

  private patch(update: Partial<CopySnapshot>): void {
    if (!this.current) return;
    this.current = {
      ...this.current,
      ...update,
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
  }

  private moveTo(status: CopyStatus, stage: CopyStage): void {
    if (!this.current) {
      throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    }
    this.current = {
      ...transitionCopy(
        this.current,
        status,
        this.options.now?.() ?? new Date(),
      ),
      stage,
    };
    this.emit();
  }

  private emit(): void {
    if (this.current) {
      this.options.onUpdate?.(structuredClone(this.current));
    }
  }
}
