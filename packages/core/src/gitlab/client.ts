import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AppConfig } from '../config.ts';
import { BASE_BRANCH_NAME } from '../client-branch.ts';
import {
  DsmError,
  type DsmErrorCode,
  type TaskStage,
} from '../errors.ts';
import type { HttpTransport } from '../ports/http.ts';

export interface GitLabUser {
  id: number;
  username: string;
}

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  empty_repo: boolean;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

export interface GitLabBranch {
  name: string;
  default: boolean;
  protected: boolean;
  commit?: { id: string };
}

export interface GitLabCommit {
  id: string;
  short_id?: string;
  title?: string;
  message?: string;
}

export interface FileMetadata {
  exists: boolean;
  lastCommitId: string | null;
  size: number | null;
}

export interface UploadPreparation {
  project: GitLabProject;
  branch: string;
  branchExists: boolean;
  sourceBranch: string | null;
  file: FileMetadata;
}

export interface UploadRequest {
  fileName: string;
  contentBase64: string;
  taskMarker: string;
  branchMissing: boolean;
  fileExists: boolean;
  lastCommitId: string | null;
}

export interface UploadResponse {
  action: 'created' | 'updated' | 'initialized';
  repositoryFilePath: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
}

export interface GitLabClientOptions {
  transport: HttpTransport;
  baseUrl: string;
  token: string;
  projectId: string;
  clientBranch: string;
  apiTimeoutMs: number;
  downloadTimeoutMs: number;
}

export class GitLabApiError extends DsmError {
  constructor(
    readonly method: string,
    readonly apiPath: string,
    readonly responseStatus: number,
    message: string,
    stage: TaskStage = 'UPLOAD',
  ) {
    super(
      gitLabErrorCode(responseStatus),
      `同步服务请求失败（${responseStatus}）：${message}`,
      stage,
      responseStatus === 408 ||
        responseStatus === 429 ||
        responseStatus >= 500,
      responseStatus,
    );
    this.name = 'GitLabApiError';
  }
}

function gitLabErrorCode(status: number): DsmErrorCode {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 408 || status === 429 || status >= 500) return 'NETWORK_ERROR';
  return 'ARCHIVE_DOWNLOAD_FAILED';
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function safeErrorMessage(status: number, text: string): string {
  let message = text.slice(0, 800);
  try {
    const payload = JSON.parse(text) as {
      message?: string;
      error_description?: string;
      error?: string;
    };
    message = payload.message ?? payload.error_description ?? payload.error ?? message;
  } catch {
    // Keep a bounded response body.
  }
  if (status === 401) return '访问令牌无效或已过期';
  if (status === 403) return '当前访问令牌无权执行此操作';
  return message.replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly clientBranch: string;

  constructor(private readonly options: GitLabClientOptions) {
    if (!options.token) {
      throw new DsmError('TOKEN_MISSING', '请先配置访问令牌', 'CHECK', true);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.projectId = options.projectId;
    this.clientBranch = options.clientBranch;
  }

  static fromConfig(
    config: AppConfig,
    token: string,
    transport: HttpTransport,
    clientBranch: string,
  ): GitLabClient {
    return new GitLabClient({
      transport,
      baseUrl: config.gitlabUrl,
      token,
      projectId: config.projectId,
      clientBranch,
      apiTimeoutMs: config.apiTimeoutMs,
      downloadTimeoutMs: config.downloadTimeoutMs,
    });
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.getJson<GitLabUser>('/user');
  }

  async getProject(): Promise<GitLabProject> {
    return this.getJson<GitLabProject>(this.projectBase());
  }

  async getBranch(name = this.clientBranch): Promise<GitLabBranch | null> {
    try {
      return await this.getJson<GitLabBranch>(
        `${this.projectBase()}/repository/branches/${encodeSegment(name)}`,
      );
    } catch (error) {
      if (error instanceof GitLabApiError && error.responseStatus === 404) {
        return null;
      }
      throw error;
    }
  }

  async testConnection(): Promise<{
    user: GitLabUser;
    project: GitLabProject;
    baseBranch: GitLabBranch | null;
  }> {
    const [user, project] = await Promise.all([
      this.getCurrentUser(),
      this.getProject(),
    ]);
    const baseBranch = project.empty_repo
      ? null
      : await this.getBranch(BASE_BRANCH_NAME);
    return { user, project, baseBranch };
  }

  async getFileMetadata(fileName: string): Promise<FileMetadata> {
    const response = await this.requestRaw(
      `${this.fileApiPath(fileName)}?ref=${encodeSegment(this.clientBranch)}`,
      { method: 'HEAD' },
      true,
    );
    if (response.status === 404) {
      return { exists: false, lastCommitId: null, size: null };
    }
    if (!response.ok) {
      await this.throwResponseError(response, 'HEAD', this.fileApiPath(fileName));
    }
    const sizeHeader = response.headers.get('content-length');
    return {
      exists: true,
      lastCommitId: response.headers.get('x-gitlab-last-commit-id'),
      size: sizeHeader ? Number(sizeHeader) : null,
    };
  }

  async prepareUpload(fileName: string): Promise<UploadPreparation> {
    const project = await this.getProject();
    const branch = await this.getBranch();
    let sourceBranch: string | null = null;
    if (!branch && !project.empty_repo) {
      const baseBranch = await this.getBranch(BASE_BRANCH_NAME);
      if (!baseBranch) {
        throw new DsmError(
          'BRANCH_CREATE_FAILED',
          `基础分支 ${BASE_BRANCH_NAME} 不存在，请先在同步服务中创建空模板分支`,
          'CHECK',
        );
      }
      sourceBranch = BASE_BRANCH_NAME;
    }

    return {
      project,
      branch: this.clientBranch,
      branchExists: Boolean(branch),
      sourceBranch,
      file: branch
        ? await this.getFileMetadata(fileName)
        : { exists: false, lastCommitId: null, size: null },
    };
  }

  async ensureBranch(
    sourceBranch: string | null,
  ): Promise<'created' | 'existing' | 'empty-repo'> {
    if (await this.getBranch()) {
      return 'existing';
    }
    if (sourceBranch) {
      try {
        await this.requestJson<GitLabBranch>(
          `${this.projectBase()}/repository/branches`,
          {
            method: 'POST',
            body: { branch: this.clientBranch, ref: sourceBranch },
          },
          'UPLOAD',
        );
        return 'created';
      } catch (error) {
        if (
          error instanceof GitLabApiError &&
          error.responseStatus === 400 &&
          (await this.getBranch())
        ) {
          return 'existing';
        }
        throw error;
      }
    }

    const project = await this.getProject();
    if (project.empty_repo) {
      return 'empty-repo';
    }
    throw new DsmError(
      'BRANCH_CREATE_FAILED',
      `基础分支 ${BASE_BRANCH_NAME} 不存在，无法创建任务分支`,
      'UPLOAD',
    );
  }

  async uploadFile(request: UploadRequest): Promise<UploadResponse> {
    const commitMessage = `[dsm:${request.taskMarker}] Upload ${request.fileName}`;

    if (request.branchMissing) {
      await this.requestJson<GitLabCommit>(
        `${this.projectBase()}/repository/commits`,
        {
          method: 'POST',
          body: {
            branch: this.clientBranch,
            commit_message: commitMessage,
            actions: [
              {
                action: 'create',
                file_path: request.fileName,
                content: request.contentBase64,
                encoding: 'base64',
              },
            ],
          },
        },
        'UPLOAD',
      );
      return {
        action: 'initialized',
        repositoryFilePath: request.fileName,
      };
    }

    const method = request.fileExists ? 'PUT' : 'POST';
    const body: Record<string, unknown> = {
      branch: this.clientBranch,
      content: request.contentBase64,
      encoding: 'base64',
      commit_message: commitMessage,
    };
    if (request.fileExists && request.lastCommitId) {
      body.last_commit_id = request.lastCommitId;
    }

    const result = await this.requestJson<{ file_path?: string }>(
      this.fileApiPath(request.fileName),
      { method, body },
      'UPLOAD',
    );
    return {
      action: request.fileExists ? 'updated' : 'created',
      repositoryFilePath: result.file_path ?? request.fileName,
    };
  }

  async findCommitByMarker(
    fileName: string,
    taskMarker: string,
  ): Promise<GitLabCommit | null> {
    const commits = await this.getJson<GitLabCommit[]>(
      `${this.projectBase()}/repository/commits?ref_name=${encodeSegment(
        this.clientBranch,
      )}&path=${encodeSegment(fileName)}&per_page=20`,
    );
    return (
      commits.find((commit) =>
        `${commit.title ?? ''}\n${commit.message ?? ''}`.includes(taskMarker),
      ) ?? null
    );
  }

  async downloadArchive(
    ref: string,
    destinationPath: string,
    limits: AppConfig['archiveLimits'],
    temporaryPath = `${destinationPath}.part`,
  ): Promise<{ archivePath: string; archiveSize: number }> {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.rm(temporaryPath, { force: true });

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.downloadArchiveAttempt(
          ref,
          temporaryPath,
          destinationPath,
          limits,
        );
      } catch (error) {
        lastError = error;
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        if (!isRetryable(error) || attempt === 1) {
          break;
        }
      }
    }
    throw lastError;
  }

  private async downloadArchiveAttempt(
    ref: string,
    temporaryPath: string,
    destinationPath: string,
    limits: AppConfig['archiveLimits'],
  ): Promise<{ archivePath: string; archiveSize: number }> {
    const apiPath = `${this.projectBase()}/repository/archive.zip?sha=${encodeSegment(
      ref,
    )}`;
    const response = await this.requestRaw(
      apiPath,
      {
        timeoutMs: this.options.downloadTimeoutMs,
        accept: 'application/zip, application/octet-stream',
      },
      false,
      'DOWNLOAD',
    );
    const contentType = response.headers.get('content-type') ?? '';
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
      throw new DsmError(
        'ARCHIVE_INVALID',
        `同步服务返回了无法识别的压缩包：${contentType || '未知类型'}`,
        'DOWNLOAD',
      );
    }
    if (contentLength > limits.maxBytes) {
      throw new DsmError(
        'ARCHIVE_TOO_LARGE',
        '归档大小超过允许上限',
        'DOWNLOAD',
      );
    }
    if (!response.body) {
      throw new DsmError('ARCHIVE_INVALID', '同步服务返回了空压缩包', 'DOWNLOAD');
    }

    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    const stat = await fs.stat(temporaryPath);
    if (stat.size === 0) {
      throw new DsmError('ARCHIVE_INVALID', '下载的归档为空', 'DOWNLOAD');
    }
    if (stat.size > limits.maxBytes) {
      throw new DsmError('ARCHIVE_TOO_LARGE', '归档大小超过允许上限', 'DOWNLOAD');
    }
    if (contentLength > 0 && stat.size !== contentLength) {
      throw new DsmError('ARCHIVE_INVALID', '归档下载不完整', 'DOWNLOAD', true);
    }

    await fs.rename(temporaryPath, destinationPath);
    return { archivePath: destinationPath, archiveSize: stat.size };
  }

  private projectBase(): string {
    return `/projects/${encodeSegment(this.projectId)}`;
  }

  private fileApiPath(fileName: string): string {
    return `${this.projectBase()}/repository/files/${encodeSegment(fileName)}`;
  }

  private async getJson<T>(apiPath: string): Promise<T> {
    return this.requestJson<T>(apiPath, {}, 'UPLOAD');
  }

  private async requestJson<T>(
    apiPath: string,
    options: RequestOptions,
    stage: TaskStage,
  ): Promise<T> {
    const response = await this.requestRaw(apiPath, options, false, stage);
    return (await response.json()) as T;
  }

  private async requestRaw(
    apiPath: string,
    options: RequestOptions,
    allowNotFound: boolean,
    stage: TaskStage = 'UPLOAD',
  ): Promise<Response> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
      Accept: options.accept ?? 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.options.transport.request(
        `${this.baseUrl}/api/v4${apiPath}`,
        {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          // undici derives `Sec-Fetch-Mode` from RequestInit.mode and ignores a
          // header with the same name. GitLab rejects the default `cors` value
          // for repository endpoints with HTTP 406, but accepts `same-origin`.
          ...(method === 'GET' ? { mode: 'same-origin' as const } : {}),
          signal: AbortSignal.timeout(
            options.timeoutMs ?? this.options.apiTimeoutMs,
          ),
        },
      );
    } catch (error) {
      throw new DsmError(
        'NETWORK_ERROR',
        error instanceof Error && error.name === 'TimeoutError'
          ? '请求超时'
          : '无法连接同步服务',
        stage,
        true,
      );
    }

    if (allowNotFound && response.status === 404) {
      return response;
    }
    if (!response.ok) {
      await this.throwResponseError(response, method, apiPath, stage);
    }
    return response;
  }

  private async throwResponseError(
    response: Response,
    method: string,
    apiPath: string,
    stage: TaskStage = 'UPLOAD',
  ): Promise<never> {
    const text = await response.text().catch(() => '');
    throw new GitLabApiError(
      method,
      apiPath,
      response.status,
      safeErrorMessage(response.status, text),
      stage,
    );
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof GitLabApiError) {
    return (
      error.responseStatus === 408 ||
      error.responseStatus === 429 ||
      error.responseStatus >= 500
    );
  }
  return error instanceof DsmError && error.code === 'NETWORK_ERROR';
}
