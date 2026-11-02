import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Config } from './config.ts';

interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
  mode?: RequestInit['mode'];
}

interface GitLabProjectPermissions {
  project_access?: {
    access_level: number;
  } | null;
  group_access?: {
    access_level: number;
  } | null;
}

export interface GitLabUser {
  id: number;
  username: string;
}

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  empty_repo: boolean;
  permissions?: GitLabProjectPermissions;
}

interface GitLabBranch {
  name: string;
  default: boolean;
  protected: boolean;
}

interface GitLabCommit {
  id: string;
  short_id: string;
}

interface BranchState {
  exists: boolean;
  project: GitLabProject;
}

export interface UploadResult {
  action: string;
  repositoryFilePath: string;
  commitId?: string;
}

export interface ArchiveResult {
  archivePath: string;
  archiveSize: number;
}

type ApiClient = (
  apiPath: string,
  options?: ApiRequestOptions,
) => Promise<Response>;

export class GitLabApiError extends Error {
  constructor(
    readonly method: string,
    readonly apiPath: string,
    readonly status: number,
    message: string,
  ) {
    super(`GitLab API ${method} ${apiPath} failed (${status}): ${message}`);
    this.name = 'GitLabApiError';
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function createApiClient(config: Config): ApiClient {
  return async (
    apiPath,
    {
      method = 'GET',
      body,
      timeoutMs = 30_000,
      accept = 'application/json',
      mode = 'cors',
    } = {},
  ) => {
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': config.token,
      Accept: accept,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${config.baseUrl}/api/v4${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      mode,
    });

    if (!response.ok) {
      const responseText = await response.text();
      let message = responseText.slice(0, 1_000);

      try {
        const payload = JSON.parse(responseText) as {
          message?: string;
          error_description?: string;
          error?: string;
        };
        message =
          payload.message ??
          payload.error_description ??
          payload.error ??
          JSON.stringify(payload);
      } catch {
        // Preserve the raw response when GitLab does not return JSON.
      }

      throw new GitLabApiError(method, apiPath, response.status, message);
    }

    return response;
  };
}

async function requestJson<T>(
  request: ApiClient,
  apiPath: string,
  options?: ApiRequestOptions,
): Promise<T> {
  const response = await request(apiPath, options);
  return (await response.json()) as T;
}

export async function getCurrentUser(
  request: ApiClient,
): Promise<GitLabUser> {
  return requestJson<GitLabUser>(request, '/user');
}

export async function getProject(
  request: ApiClient,
  config: Config,
): Promise<GitLabProject> {
  return requestJson<GitLabProject>(
    request,
    `/projects/${encodePathSegment(config.projectId)}`,
  );
}

async function ensureBranch(
  request: ApiClient,
  config: Config,
  project: GitLabProject,
): Promise<BranchState> {
  const projectPath = `/projects/${encodePathSegment(config.projectId)}`;
  const branchPath = `${projectPath}/repository/branches/${encodePathSegment(config.branch)}`;

  try {
    await requestJson<GitLabBranch>(request, branchPath);
    return { exists: true, project };
  } catch (error) {
    if (!(error instanceof GitLabApiError) || error.status !== 404) {
      throw error;
    }
  }

  const branches = await requestJson<GitLabBranch[]>(
    request,
    `${projectPath}/repository/branches?per_page=100`,
  );

  if (branches.length === 0) {
    return { exists: false, project };
  }

  const sourceBranch = project.default_branch ?? branches[0].name;
  await requestJson<GitLabBranch>(request, `${projectPath}/repository/branches`, {
    method: 'POST',
    body: {
      branch: config.branch,
      ref: sourceBranch,
    },
  });

  console.log(`Created branch ${config.branch} from ${sourceBranch}`);
  return { exists: true, project };
}

export async function uploadFile(
  request: ApiClient,
  config: Config,
  project: GitLabProject,
): Promise<UploadResult> {
  const fileContents = await fs.readFile(config.filePath);
  const encodedContents = fileContents.toString('base64');
  const repositoryFilePath = path.basename(config.filePath);
  const commitMessage = `Upload ${repositoryFilePath} via GitLab API`;
  const projectPath = `/projects/${encodePathSegment(config.projectId)}`;
  const branchState = await ensureBranch(request, config, project);

  if (!branchState.exists) {
    let commit: GitLabCommit;

    try {
      commit = await requestJson<GitLabCommit>(
        request,
        `${projectPath}/repository/commits`,
        {
          method: 'POST',
          body: {
            branch: config.branch,
            commit_message: commitMessage,
            actions: [
              {
                action: 'create',
                file_path: repositoryFilePath,
                content: encodedContents,
                encoding: 'base64',
              },
            ],
          },
        },
      );
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 403) {
        const accessLevel =
          project.permissions?.project_access?.access_level ??
          project.permissions?.group_access?.access_level ??
          'unknown';
        throw new Error(
          `Unable to create the initial ${config.branch} branch (project access level: ${accessLevel}). ` +
            'The current token user must be allowed to push to the protected default branch, usually Maintainer access.',
        );
      }
      throw error;
    }

    console.log(`Created initial branch ${config.branch} at ${commit.short_id}`);
    return {
      action: 'created with initial commit',
      repositoryFilePath,
      commitId: commit.id,
    };
  }

  const fileApiPath = `${projectPath}/repository/files/${encodePathSegment(
    repositoryFilePath,
  )}`;
  let action: 'created' | 'updated' = 'updated';

  try {
    await request(
      `${fileApiPath}?ref=${encodePathSegment(config.branch)}`,
    );
  } catch (error) {
    if (!(error instanceof GitLabApiError) || error.status !== 404) {
      throw error;
    }
    action = 'created';
  }

  const result = await requestJson<{
    file_path?: string;
    commit_id?: string;
  }>(request, fileApiPath, {
    method: action === 'created' ? 'POST' : 'PUT',
    body: {
      branch: config.branch,
      content: encodedContents,
      encoding: 'base64',
      commit_message: commitMessage,
    },
  });

  return {
    action,
    repositoryFilePath: result.file_path ?? repositoryFilePath,
    commitId: result.commit_id,
  };
}

export async function downloadArchive(
  request: ApiClient,
  config: Config,
  timestamp: string,
): Promise<ArchiveResult> {
  const archiveApiPath = `/projects/${encodePathSegment(
    config.projectId,
  )}/repository/archive.zip?sha=${encodePathSegment(config.branch)}`;
  const safeBranch = config.branch.replace(/[^A-Za-z0-9._-]+/g, '_');
  const archivePath = path.join(
    config.extractBase,
    `gitlab-project-${safeBranch}-${timestamp}.zip`,
  );
  const response = await request(archiveApiPath, {
    timeoutMs: 120_000,
    accept: 'application/octet-stream',
    mode: 'same-origin',
  });
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
    throw new Error(`Unexpected archive response type: ${contentType || 'unknown'}`);
  }
  if (!response.body) {
    throw new Error('GitLab returned an empty archive response');
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archivePath, { flags: 'wx' }),
  );

  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size === 0) {
    throw new Error(`Downloaded archive is empty: ${archivePath}`);
  }

  return { archivePath, archiveSize: archiveStat.size };
}

export function createApiClientForConfig(config: Config): ApiClient {
  return createApiClient(config);
}
