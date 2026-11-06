import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { extractArchive } from './archive/safe-extract.ts';
import {
  resolveSaveDirectory,
  validateAppConfig,
  type AppConfig,
} from './config.ts';
import {
  asDsmError,
  DsmError,
  type TaskStage,
} from './errors.ts';
import {
  GitLabApiError,
  GitLabClient,
  type UploadPreparation,
} from './gitlab/client.ts';
import type { FileContentReader } from './ports/file-content.ts';
import type { HttpTransport } from './ports/http.ts';
import {
  ACTIVE_TASK_STATUSES,
  createTaskSnapshot,
  recoveryActionFor,
  transitionTask,
  type RecoveryAction,
  type TaskFailure,
  type TaskSnapshot,
} from './task-state.ts';
import { createLocalTimestamp } from './timestamp.ts';

export interface TaskControllerOptions {
  transport: HttpTransport;
  getConfig: () => Promise<AppConfig>;
  getToken: () => Promise<string>;
  getDocumentsDirectory: () => string;
  getTemporaryDirectory: () => string;
  /**
   * 读取待上传文件的明文内容。默认使用 fs.readFile。
   * DSM 透明加密环境由桌面端注入白名单进程读取实现。
   */
  readFileContent?: FileContentReader;
  onUpdate?: (snapshot: TaskSnapshot) => void;
  onAuthenticationFailure?: (status: number) => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

export interface TaskConfirmation {
  allowOverwrite?: boolean;
  allowCreateBranch?: boolean;
}

interface FileBaseline {
  size: number;
  modifiedAtMs: number;
}

interface TaskRuntime {
  taskId: string;
  config: AppConfig;
  token: string;
  filePath: string;
  fileName: string;
  baseline: FileBaseline;
  preparation: UploadPreparation;
  marker: string;
  branchCreated: boolean;
  archivePath: string | null;
  directoryName: string | null;
}

export class TaskController {
  private current: TaskSnapshot | null = null;
  private runtime: TaskRuntime | null = null;

  constructor(private readonly options: TaskControllerOptions) {}

  getCurrentTask(): TaskSnapshot | null {
    return this.current ? structuredClone(this.current) : null;
  }

  async start(filePath: string): Promise<TaskSnapshot> {
    if (this.current && ACTIVE_TASK_STATUSES.has(this.current.status)) {
      throw new DsmError('TASK_BUSY', '已有任务正在运行', 'CHECK');
    }

    const now = this.options.now?.() ?? new Date();
    const taskId = this.options.createId?.() ?? randomUUID();
    const fileName = path.basename(filePath);
    this.current = createTaskSnapshot(taskId, fileName, filePath, now);
    this.runtime = null;
    this.emit();

    try {
      const config = validateAppConfig(await this.options.getConfig(), {
        requireRemote: true,
      });
      const baseline = await this.validateFile(filePath, config);
      await this.validateSaveDirectory(config);
      const token = await this.options.getToken();
      if (!token) {
        this.current = {
          ...this.current,
          status: 'WAITING_FOR_TOKEN',
          failure: {
            code: 'TOKEN_MISSING',
            stage: 'CHECK',
            message: '请配置 GitLab Token 后继续',
            recoverable: true,
          },
          recoveryActions: ['CONFIGURE_TOKEN'],
        };
        this.emit();
        return this.getCurrentTask() as TaskSnapshot;
      }

      const client = GitLabClient.fromConfig(config, token, this.options.transport);
      const preparation = await client.prepareUpload(fileName);
      const marker = `${taskId}-${now.getTime()}`;
      this.runtime = {
        taskId,
        config,
        token,
        filePath,
        fileName,
        baseline,
        preparation,
        marker,
        branchCreated: false,
        archivePath: null,
        directoryName: null,
      };
      this.current = {
        ...this.current,
        branch: config.branch,
        remotePath: fileName,
        sourceBranch: preparation.sourceBranch,
      };

      if (!preparation.branchExists) {
        return this.waitForConfirmation(
          'WAITING_FOR_BRANCH_CONFIRMATION',
          '目标分支不存在，确认后将从源分支创建',
        );
      }
      if (preparation.file.exists) {
        return this.waitForConfirmation(
          'WAITING_FOR_OVERWRITE_CONFIRMATION',
          '远端存在同名文件，确认后将覆盖',
        );
      }

      return await this.uploadAndFinish(this.runtime);
    } catch (error) {
      return await this.fail(error, 'CHECK');
    }
  }

  async confirm(
    taskId: string,
    confirmation: TaskConfirmation,
  ): Promise<TaskSnapshot> {
    const runtime = this.requireRuntime(taskId);
    if (!this.current) {
      throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    }

    try {
      if (this.current.status === 'WAITING_FOR_BRANCH_CONFIRMATION') {
        if (!confirmation.allowCreateBranch) {
          throw new DsmError(
            'INVALID_REQUEST',
            '未确认创建目标分支，任务已停止',
            'UPLOAD',
          );
        }
        this.moveTo('CHECKING', 'CHECK');
        const client = this.clientFor(runtime);
        await client.createBranch(runtime.preparation.sourceBranch);
        runtime.branchCreated = true;
        if (this.current) {
          this.current = { ...this.current, branchCreated: true };
        }

        if (runtime.preparation.sourceBranch) {
          const metadata = await client.getFileMetadata(runtime.fileName);
          runtime.preparation.file = metadata;
          runtime.preparation.branchExists = true;
          if (metadata.exists) {
            return this.waitForConfirmation(
              'WAITING_FOR_OVERWRITE_CONFIRMATION',
              '远端源分支已有同名文件，确认后将覆盖',
            );
          }
        }
        return await this.uploadAndFinish(runtime);
      }

      if (this.current.status === 'WAITING_FOR_OVERWRITE_CONFIRMATION') {
        if (!confirmation.allowOverwrite) {
          throw new DsmError(
            'INVALID_REQUEST',
            '未确认覆盖远端同名文件，任务已停止',
            'UPLOAD',
          );
        }
        this.moveTo('UPLOADING', 'UPLOAD');
        return await this.uploadAndFinish(runtime);
      }

      return this.getCurrentTask() as TaskSnapshot;
    } catch (error) {
      return await this.fail(error, 'UPLOAD');
    }
  }

  async recover(
    taskId: string,
    action: RecoveryAction,
  ): Promise<TaskSnapshot> {
    if (!this.current || this.current.taskId !== taskId) {
      throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    }
    if (action === 'CONFIGURE_TOKEN') {
      return this.resumeWithToken(this.current);
    }

    const runtime = this.requireRuntime(taskId);
    try {
      if (action === 'QUERY_COMMIT') {
        this.moveTo('CHECKING', 'COMMIT_LOOKUP');
        return await this.locateCommitAndContinue(runtime);
      }

      if (!this.current?.commitId) {
        throw new DsmError(
          'TASK_NOT_FOUND',
          '当前任务没有可用于恢复的 Commit ID',
          'CHECK',
        );
      }

      if (action === 'RETRY_DOWNLOAD') {
        return await this.downloadExtractAndClean(runtime, this.current.commitId);
      }
      if (action === 'RETRY_EXTRACTION') {
        return await this.extractAndClean(runtime, this.current.commitId);
      }
      if (action === 'RETRY_CLEANUP') {
        return await this.cleanAndFinish(runtime);
      }

      throw new DsmError('INVALID_REQUEST', '不支持的恢复操作', 'CHECK');
    } catch (error) {
      const stage = action === 'RETRY_CLEANUP'
        ? 'CLEANUP'
        : action === 'RETRY_EXTRACTION'
          ? 'EXTRACT'
          : 'DOWNLOAD';
      return await this.fail(error, stage);
    }
  }

  private async resumeWithToken(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
    if (!(await this.options.getToken())) {
      return this.waitForToken(snapshot);
    }

    if (snapshot.commitId) {
      try {
        this.moveTo('DOWNLOADING', 'DOWNLOAD');
        return await this.downloadExtractAndClean(
          this.requireRuntime(snapshot.taskId),
          snapshot.commitId,
        );
      } catch (error) {
        return await this.fail(error, 'DOWNLOAD');
      }
    }

    const filePath = snapshot.localFilePath;
    if (!filePath) {
      throw new DsmError('TASK_NOT_FOUND', '任务没有可恢复的本地文件', 'CHECK');
    }
    this.runtime = null;
    this.current = null;
    return this.start(filePath);
  }

  private waitForToken(snapshot: TaskSnapshot): TaskSnapshot {
    this.current = {
      ...snapshot,
      status: 'WAITING_FOR_TOKEN',
      stage: 'CHECK',
      failure: {
        code: 'TOKEN_MISSING',
        stage: 'CHECK',
        message: '请配置 GitLab Token 后继续',
        recoverable: true,
      },
      recoveryActions: ['CONFIGURE_TOKEN'],
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
    return this.getCurrentTask() as TaskSnapshot;
  }

  private async uploadAndFinish(runtime: TaskRuntime): Promise<TaskSnapshot> {
    const client = this.clientFor(runtime);
    if (this.current?.status !== 'UPLOADING') {
      this.moveTo('UPLOADING', 'UPLOAD');
    }

    let content: Buffer;
    try {
      const stat = await fs.stat(runtime.filePath);
      if (
        stat.size !== runtime.baseline.size ||
        stat.mtimeMs !== runtime.baseline.modifiedAtMs
      ) {
        throw new DsmError(
          'FILE_CHANGED',
          '文件在确认后发生变化，请重新开始任务',
          'CHECK',
        );
      }
      content = this.options.readFileContent
        ? await this.options.readFileContent(runtime.filePath, {
            maxBytes: runtime.config.maxUploadBytes,
          })
        : await fs.readFile(runtime.filePath);
      // 透明加密下明文长度可能与磁盘 stat 大小不同，因此不再要求
      // content.length === stat.size；但读取期间磁盘文件不应再变化。
      const afterRead = await fs.stat(runtime.filePath).catch(() => null);
      if (!afterRead?.isFile() || afterRead.size !== stat.size) {
        throw new DsmError('FILE_CHANGED', '读取文件时文件发生变化', 'CHECK');
      }
      if (content.length === 0) {
        throw new DsmError('FILE_INVALID', '不能上传空文件', 'CHECK');
      }
      if (content.length > runtime.config.maxUploadBytes) {
        throw new DsmError(
          'FILE_TOO_LARGE',
          '文件超过上传大小上限',
          'CHECK',
        );
      }
    } catch (error) {
      return await this.fail(error, 'CHECK');
    }

    try {
      await client.uploadFile({
        fileName: runtime.fileName,
        contentBase64: content.toString('base64'),
        taskMarker: runtime.marker,
        branchExists: runtime.preparation.branchExists,
        branchMissing: !runtime.preparation.branchExists,
        fileExists: runtime.preparation.file.exists,
        lastCommitId: runtime.preparation.file.lastCommitId,
      });
      if (!runtime.preparation.branchExists) {
        runtime.branchCreated = true;
        if (this.current) {
          this.current = { ...this.current, branchCreated: true };
        }
      }
    } catch (error) {
      await this.handleAuthenticationFailure(error);
      return await this.failUpload(error, runtime);
    }

    this.moveTo('UPLOADED', 'COMMIT_LOOKUP');
    return this.locateCommitAndContinue(runtime);
  }

  private async locateCommitAndContinue(
    runtime: TaskRuntime,
  ): Promise<TaskSnapshot> {
    let commitId: string | null;
    try {
      const commit = await this.clientFor(runtime).findCommitByMarker(
        runtime.fileName,
        runtime.marker,
      );
      commitId = commit?.id ?? null;
    } catch (error) {
      await this.handleAuthenticationFailure(error);
      return await this.failProjectUnknown(error, runtime);
    }

    if (!commitId) {
      return await this.failProjectUnknown(
        new Error('上传未确认产生 Commit，任务结果未知'),
        runtime,
      );
    }
    if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    this.current = { ...this.current, commitId };
    this.emit();
    return this.downloadExtractAndClean(runtime, commitId);
  }

  private async downloadExtractAndClean(
    runtime: TaskRuntime,
    commitId: string,
  ): Promise<TaskSnapshot> {
    if (this.current?.status !== 'DOWNLOADING') {
      this.moveTo('DOWNLOADING', 'DOWNLOAD');
    }
    const saveDirectory = resolveSaveDirectory(
      runtime.config,
      this.options.getDocumentsDirectory(),
    );
    const timestamp = runtime.directoryName ?? this.uniqueTimestamp(runtime);
    runtime.directoryName = timestamp;
    const safeBranch = runtime.config.branch.replace(/[^A-Za-z0-9._-]+/g, '_');
    const archivePath = path.join(
      saveDirectory,
      `gitlab-project-${safeBranch}-${timestamp}.zip`,
    );

    try {
      const result = await this.clientFor(runtime).downloadArchive(
        commitId,
        archivePath,
        runtime.config.archiveLimits,
        path.join(saveDirectory, `.dsm-${runtime.taskId}.zip.part`),
      );
      runtime.archivePath = result.archivePath;
      if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
      this.current = { ...this.current, archivePath: result.archivePath };
      this.emit();
    } catch (error) {
      await this.handleAuthenticationFailure(error);
      return await this.fail(error, 'DOWNLOAD');
    }
    return this.extractAndClean(runtime, commitId);
  }

  private async extractAndClean(
    runtime: TaskRuntime,
    commitId: string,
  ): Promise<TaskSnapshot> {
    this.moveTo('EXTRACTING', 'EXTRACT');
    const saveDirectory = resolveSaveDirectory(
      runtime.config,
      this.options.getDocumentsDirectory(),
    );

    try {
      if (!runtime.archivePath || !(await fs.stat(runtime.archivePath).catch(() => null))) {
        const safeBranch = runtime.config.branch.replace(/[^A-Za-z0-9._-]+/g, '_');
        const timestamp = runtime.directoryName ?? this.uniqueTimestamp(runtime);
        runtime.directoryName = timestamp;
        const downloaded = await this.clientFor(runtime).downloadArchive(
          commitId,
          path.join(
            saveDirectory,
            `gitlab-project-${safeBranch}-${timestamp}.zip`,
          ),
          runtime.config.archiveLimits,
          path.join(saveDirectory, `.dsm-${runtime.taskId}.zip.part`),
        );
        runtime.archivePath = downloaded.archivePath;
      }

      const result = await extractArchive(
        runtime.archivePath,
        saveDirectory,
        runtime.directoryName ?? this.uniqueTimestamp(runtime),
        {
          limits: runtime.config.archiveLimits,
          windows: process.platform === 'win32',
          caseInsensitive: process.platform === 'win32',
          requiredRelativePath: this.current?.remotePath ?? runtime.fileName,
        },
      );
      const remoteFilePath = this.current?.remotePath ?? runtime.fileName;
      const expectedPath = path.resolve(
        result.finalDirectory,
        ...remoteFilePath.split('/'),
      );
      const expectedStat = await fs.stat(expectedPath).catch(() => null);
      if (!expectedStat?.isFile()) {
        throw new DsmError(
          'EXTRACTION_FAILED',
          `解压后未找到上传文件：${remoteFilePath}`,
          'EXTRACT',
        );
      }

      if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
      this.current = {
        ...this.current,
        resultDirectory: result.finalDirectory,
      };
      return await this.cleanAndFinish(runtime);
    } catch (error) {
      return await this.fail(error, 'EXTRACT');
    }
  }

  private async cleanAndFinish(runtime: TaskRuntime): Promise<TaskSnapshot> {
    this.moveTo('CLEANING', 'CLEANUP');
    const keptArchive = runtime.config.keepArchive
      ? runtime.archivePath
      : null;
    if (!runtime.config.keepArchive && runtime.archivePath) {
      try {
        await fs.rm(runtime.archivePath, { force: true });
        await fs.rm(`${runtime.archivePath}.part`, { force: true });
      } catch (error) {
        if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
        this.current = {
          ...this.current,
          status: 'SUCCESS_WITH_WARNING',
          archivePath: runtime.archivePath,
          warning:
            error instanceof Error ? error.message : '清理临时归档失败',
          failure: null,
          recoveryActions: ['RETRY_CLEANUP'],
          updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
        };
        this.emit();
        return this.getCurrentTask() as TaskSnapshot;
      }
    }

    if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    this.current = {
      ...this.current,
      status: 'SUCCESS',
      stage: 'CLEANUP',
      archivePath: keptArchive,
      failure: null,
      warning: null,
      recoveryActions: [],
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
    return this.getCurrentTask() as TaskSnapshot;
  }

  private async failUpload(
    error: unknown,
    runtime: TaskRuntime,
  ): Promise<TaskSnapshot> {
    if (error instanceof GitLabApiError && error.responseStatus === 400) {
      try {
        const metadata = await this.clientFor(runtime).getFileMetadata(runtime.fileName);
        if (
          metadata.lastCommitId &&
          metadata.lastCommitId !== runtime.preparation.file.lastCommitId
        ) {
          runtime.preparation.file = metadata;
          return this.waitForConfirmation(
            'WAITING_FOR_OVERWRITE_CONFIRMATION',
            '远端文件已被其他提交修改，请重新确认覆盖',
          );
        }
      } catch {
        // The original upload error remains the primary result.
      }
    }

    if (isAmbiguousUploadFailure(error)) {
      try {
        const commit = await this.clientFor(runtime).findCommitByMarker(
          runtime.fileName,
          runtime.marker,
        );
        if (commit) {
          if (!this.current) {
            throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
          }
          this.current = { ...this.current, commitId: commit.id };
          this.moveTo('UPLOADED', 'COMMIT_LOOKUP');
          return this.downloadExtractAndClean(runtime, commit.id);
        }
      } catch (queryError) {
        return this.failProjectUnknown(queryError, runtime);
      }
      return this.failProjectUnknown(error, runtime);
    }

    const failed = await this.fail(error, 'UPLOAD');
    if (failed.failure?.code === 'UPLOAD_RESULT_UNKNOWN') {
      return failed;
    }
    return failed;
  }

  private async failProjectUnknown(
    error: unknown,
    runtime: TaskRuntime,
  ): Promise<TaskSnapshot> {
    const dsmError = asDsmError(error, 'COMMIT_LOOKUP', 'UPLOAD_RESULT_UNKNOWN');
    return this.applyFailure(
      new DsmError(
        'UPLOAD_RESULT_UNKNOWN',
        `上传结果未知，可能已经产生 Commit。${dsmError.message}`,
        'COMMIT_LOOKUP',
        true,
      ),
      runtime,
    );
  }

  private async fail(error: unknown, stage: TaskStage): Promise<TaskSnapshot> {
    await this.handleAuthenticationFailure(error);
    return this.applyFailure(asDsmError(error, stage), this.runtime);
  }

  private applyFailure(
    error: DsmError,
    runtime: TaskRuntime | null,
  ): TaskSnapshot {
    if (!this.current) throw error;
    const failure: TaskFailure = {
      code: error.code,
      stage: error.stage,
      message: error.message,
      recoverable: error.recoverable,
    };
    const action = recoveryActionFor(failure);
    this.current = {
      ...this.current,
      status: error.code === 'TOKEN_MISSING' ? 'WAITING_FOR_TOKEN' : 'FAILED',
      stage: error.stage,
      failure,
      recoveryActions:
        action && (runtime || action === 'CONFIGURE_TOKEN') ? [action] : [],
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
    return this.getCurrentTask() as TaskSnapshot;
  }

  private waitForConfirmation(
    status: 'WAITING_FOR_OVERWRITE_CONFIRMATION' | 'WAITING_FOR_BRANCH_CONFIRMATION',
    message: string,
  ): TaskSnapshot {
    if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    this.current = {
      ...this.current,
      status,
      failure: {
        code:
          status === 'WAITING_FOR_OVERWRITE_CONFIRMATION'
            ? 'OVERWRITE_CONFIRMATION_REQUIRED'
            : 'BRANCH_CONFIRMATION_REQUIRED',
        stage: 'CHECK',
        message,
        recoverable: true,
      },
      recoveryActions: [],
      updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.emit();
    return this.getCurrentTask() as TaskSnapshot;
  }

  private async validateFile(
    filePath: string,
    config: AppConfig,
  ): Promise<FileBaseline> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError('FILE_INVALID', '请选择有效的普通文件', 'CHECK');
    }
    if (stat.size <= 0) {
      throw new DsmError('FILE_INVALID', '不能上传空文件', 'CHECK');
    }
    if (stat.size > config.maxUploadBytes) {
      throw new DsmError('FILE_TOO_LARGE', '文件超过上传大小上限', 'CHECK');
    }
    await fs.access(filePath, fs.constants.R_OK);
    return { size: stat.size, modifiedAtMs: stat.mtimeMs };
  }

  private async validateSaveDirectory(config: AppConfig): Promise<void> {
    const saveDirectory = resolveSaveDirectory(
      config,
      this.options.getDocumentsDirectory(),
    );
    try {
      await fs.mkdir(saveDirectory, { recursive: true });
      await fs.access(saveDirectory, fs.constants.W_OK);
    } catch (error) {
      throw new DsmError(
        'SAVE_DIRECTORY_UNAVAILABLE',
        `保存目录不可写：${error instanceof Error ? error.message : String(error)}`,
        'CHECK',
      );
    }
  }

  private clientFor(runtime: TaskRuntime): GitLabClient {
    return GitLabClient.fromConfig(
      runtime.config,
      runtime.token,
      this.options.transport,
    );
  }

  private uniqueTimestamp(runtime: TaskRuntime): string {
    const base = createLocalTimestamp(this.options.now?.() ?? new Date());
    return `${base}-${runtime.taskId.slice(0, 6)}`;
  }

  private moveTo(status: TaskSnapshot['status'], stage: TaskStage): void {
    if (!this.current) throw new DsmError('TASK_NOT_FOUND', '任务不存在', 'CHECK');
    this.current = transitionTask(
      { ...this.current, stage },
      status,
      this.options.now?.() ?? new Date(),
    );
    this.emit();
  }

  private requireRuntime(taskId: string): TaskRuntime {
    if (!this.runtime || this.runtime.taskId !== taskId) {
      throw new DsmError('TASK_NOT_FOUND', '找不到可继续的任务', 'CHECK');
    }
    return this.runtime;
  }

  private async handleAuthenticationFailure(error: unknown): Promise<void> {
    if (
      error instanceof GitLabApiError &&
      (error.responseStatus === 401 || error.responseStatus === 403)
    ) {
      await this.options.onAuthenticationFailure?.(error.responseStatus);
    }
  }

  private emit(): void {
    if (this.current) {
      this.options.onUpdate?.(structuredClone(this.current));
    }
  }
}

function isAmbiguousUploadFailure(error: unknown): boolean {
  return error instanceof DsmError && error.code === 'NETWORK_ERROR';
}
