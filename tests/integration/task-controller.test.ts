import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDefaultConfig,
  TaskController,
  type AppConfig,
  type HttpTransport,
  type TaskControllerOptions,
} from '@dsm/core';

const CLIENT_NAMESPACE = 'tester-host';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('TaskController with fake GitLab', () => {
  it('creates a per-task branch, uploads once, and downloads that branch archive', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab();
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(task.branch).toMatch(
      /^tester-host\/\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/,
    );
    expect(task.sourceBranch).toBe('main');
    expect(task.branchCreated).toBe(true);
    expect(task.commitId).toBe('commit-1');
    expect(fake.uploadCount).toBe(1);
    expect(fake.branchCreateCount).toBe(1);
    expect(fake.lastBranchCreateBody).toEqual({
      branch: task.branch,
      ref: 'main',
    });
    expect(fake.archiveRefs).toEqual([task.branch]);
    expect(fake.archiveModes).toEqual(['same-origin']);
    expect(
      await fs.readFile(
        path.join(task.resultDirectory as string, 'uploaded.txt'),
        'utf8',
      ),
    ).toBe('uploaded content');
    expect(
      await fs.readdir(task.resultDirectory as string, { recursive: true }),
    ).toEqual(['uploaded.txt']);
    expect(task.archivePath).toBeNull();
  });

  it('uses a new timestamped branch for every task', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab();

    const first = await makeController(root, saveDirectory, fake).start(
      sourcePath,
    );
    const second = await makeController(root, saveDirectory, fake).start(
      sourcePath,
    );

    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');
    expect(first.branch).not.toBe(second.branch);
    expect(fake.branchCreateCount).toBe(2);
    expect(fake.archiveRefs).toEqual([first.branch, second.branch]);
  });

  it('does not create a final result directory when the archive lacks the file', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ archivedFileName: 'different.txt' });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('FAILED');
    expect(task.failure?.stage).toBe('EXTRACT');
    const names = await fs.readdir(saveDirectory);
    expect(names.filter((name) => !name.endsWith('.zip'))).toEqual([]);
  });

  it('uses last_commit_id after the user confirms an inherited overwrite', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'updated content');
    const fake = new FakeGitLab({
      fileExists: true,
      lastCommitId: 'previous-commit',
    });
    const controller = makeController(root, saveDirectory, fake);

    const waiting = await controller.start(sourcePath);
    expect(waiting.status).toBe('WAITING_FOR_OVERWRITE_CONFIRMATION');
    expect(waiting.branchCreated).toBe(true);
    expect(fake.uploadCount).toBe(0);
    expect(fake.branchCreateCount).toBe(1);

    const task = await controller.confirm(waiting.taskId, {
      allowOverwrite: true,
    });
    expect(task.status).toBe('SUCCESS');
    expect(fake.lastUploadBody?.last_commit_id).toBe('previous-commit');
    expect(fake.lastUploadMethod).toBe('PUT');
  });

  it('skips branch creation when the task branch already exists', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ branchExists: true });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(task.branchCreated).toBe(false);
    expect(fake.branchCreateCount).toBe(0);
    expect(fake.archiveRefs).toEqual([task.branch]);
  });

  it('fails clearly when the base branch is missing', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ baseBranchExists: false });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('FAILED');
    expect(task.failure?.code).toBe('BRANCH_CREATE_FAILED');
    expect(task.failure?.message).toContain('main');
    expect(fake.uploadCount).toBe(0);
    expect(fake.branchCreateCount).toBe(0);
  });

  it('creates the first branch through the Commits API in an empty repository', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ emptyRepository: true });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(task.sourceBranch).toBeNull();
    expect(task.branchCreated).toBe(true);
    expect(fake.branchCreateCount).toBe(0);
    expect(fake.initialCommitCount).toBe(1);
    expect(fake.uploadCount).toBe(0);
    expect(fake.archiveRefs).toEqual([task.branch]);
  });

  it('falls back to the commit ID when the branch tip is different', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ branchTipCommitId: 'other-commit' });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(fake.archiveRefs).toEqual(['commit-1']);
  });

  it('queries by task marker after an ambiguous upload failure without re-uploading', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({
      uploadStatus: 500,
      commitVisibleAfterFailure: true,
    });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(task.commitId).toBe('commit-1');
    expect(fake.uploadCount).toBe(1);
  });

  it('does not re-upload when an ambiguous result has no matching commit', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({
      uploadStatus: 500,
      commitVisibleAfterFailure: false,
    });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('FAILED');
    expect(task.failure?.code).toBe('UPLOAD_RESULT_UNKNOWN');
    expect(task.recoveryActions).toEqual(['QUERY_COMMIT']);
    expect(fake.uploadCount).toBe(1);
  });

  it('retries a transient archive failure exactly once', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab({ archiveFailures: 1 });
    const controller = makeController(root, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(fake.archiveRefs).toEqual([task.branch, task.branch]);
  });

  it('uploads the content returned by the injected reader', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'ciphertext on disk');
    const fake = new FakeGitLab();
    let receivedFilePath = '';
    let receivedMaxBytes = 0;

    const controller = makeController(root, saveDirectory, fake, {
      readFileContent: async (filePath, options) => {
        receivedFilePath = filePath;
        receivedMaxBytes = options.maxBytes;
        return Buffer.from('decrypted plaintext');
      },
    });

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(receivedFilePath).toBe(sourcePath);
    expect(receivedMaxBytes).toBe(createDefaultConfig().maxUploadBytes);
    expect(
      Buffer.from(String(fake.lastUploadBody?.content), 'base64').toString(
        'utf8',
      ),
    ).toBe('decrypted plaintext');
  });

  it('rejects plaintext above the upload limit after reading', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'abcd');
    const fake = new FakeGitLab();
    const controller = makeController(root, saveDirectory, fake, {
      maxUploadBytes: 4,
      readFileContent: async () => Buffer.from('abcde'),
    });

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('FAILED');
    expect(task.failure?.code).toBe('FILE_TOO_LARGE');
    expect(fake.uploadCount).toBe(0);
    expect(fake.branchCreateCount).toBe(0);
  });
});

interface FakeGitLabOptions {
  archivedFileName?: string;
  fileExists?: boolean;
  lastCommitId?: string;
  branchExists?: boolean;
  baseBranchExists?: boolean;
  emptyRepository?: boolean;
  branchTipCommitId?: string;
  uploadStatus?: number;
  commitVisibleAfterFailure?: boolean;
  archiveFailures?: number;
}

class FakeGitLab implements HttpTransport {
  uploadCount = 0;
  initialCommitCount = 0;
  branchCreateCount = 0;
  archiveRefs: string[] = [];
  archiveModes: Array<RequestInit['mode']> = [];
  lastUploadBody: Record<string, unknown> | null = null;
  lastUploadMethod = '';
  lastBranchCreateBody: Record<string, unknown> | null = null;
  private marker = '';
  private uploaded = false;
  private taskBranch: string | null = null;
  private archiveAttempts = 0;

  constructor(private readonly options: FakeGitLabOptions = {}) {}

  async request(url: string, options: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url);
    const method = options.method ?? 'GET';

    if (method === 'GET' && parsed.pathname.endsWith('/projects/group%2Fproject')) {
      return json({
        id: 12,
        path_with_namespace: 'group/project',
        default_branch: this.options.emptyRepository ? null : 'main',
        empty_repo: this.options.emptyRepository ?? false,
      });
    }

    if (method === 'GET' && parsed.pathname.includes('/repository/branches/')) {
      const branchName = decodeURIComponent(
        parsed.pathname.split('/repository/branches/')[1] ?? '',
      );
      if (branchName === 'main') {
        return (this.options.baseBranchExists ?? true) &&
          !this.options.emptyRepository
          ? json({
              name: 'main',
              default: true,
              protected: false,
              commit: { id: 'base-commit' },
            })
          : json({ message: '404 Branch Not Found' }, 404);
      }
      if (
        this.options.branchExists ||
        (this.taskBranch !== null && branchName === this.taskBranch)
      ) {
        return json({
          name: branchName,
          default: false,
          protected: false,
          commit: { id: this.branchTip() },
        });
      }
      return json({ message: '404 Branch Not Found' }, 404);
    }

    if (
      method === 'POST' &&
      parsed.pathname.endsWith('/repository/branches')
    ) {
      this.branchCreateCount += 1;
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      this.lastBranchCreateBody = body;
      this.taskBranch = String(body.branch);
      this.uploaded = false;
      this.marker = '';
      return json(
        {
          name: this.taskBranch,
          default: false,
          protected: false,
          commit: { id: 'base-commit' },
        },
        201,
      );
    }

    if (
      method === 'POST' &&
      parsed.pathname.endsWith('/repository/commits')
    ) {
      this.initialCommitCount += 1;
      const body = JSON.parse(String(options.body)) as {
        branch: string;
        commit_message: string;
      } & Record<string, unknown>;
      this.taskBranch = body.branch;
      this.marker = body.commit_message;
      this.uploaded = true;
      return json({ id: 'commit-1', parent_ids: [] }, 201);
    }

    if (method === 'HEAD' && parsed.pathname.includes('/repository/files/')) {
      return this.options.fileExists
        ? new Response(null, {
            status: 200,
            headers: {
              'x-gitlab-last-commit-id':
                this.options.lastCommitId ?? 'previous-commit',
            },
          })
        : new Response(null, { status: 404 });
    }

    if (
      (method === 'POST' || method === 'PUT') &&
      parsed.pathname.endsWith('/repository/files/uploaded.txt')
    ) {
      this.uploadCount += 1;
      this.lastUploadMethod = method;
      const body = JSON.parse(String(options.body)) as {
        commit_message: string;
      } & Record<string, unknown>;
      this.lastUploadBody = body;
      this.marker = body.commit_message;
      this.uploaded = true;
      if (this.options.uploadStatus) {
        return json({ message: 'Upload failed' }, this.options.uploadStatus);
      }
      return json({ file_path: 'uploaded.txt' }, 201);
    }

    if (method === 'GET' && parsed.pathname.endsWith('/repository/commits')) {
      const visible =
        this.uploaded &&
        (this.options.commitVisibleAfterFailure ?? true);
      return json(
        visible
          ? [
              {
                id: 'commit-1',
                title: this.marker,
                message: this.marker,
              },
            ]
          : [],
      );
    }

    if (method === 'GET' && parsed.pathname.endsWith('/repository/archive.zip')) {
      this.archiveRefs.push(parsed.searchParams.get('sha') ?? '');
      this.archiveModes.push(options.mode);
      this.archiveAttempts += 1;
      if (this.archiveAttempts <= (this.options.archiveFailures ?? 0)) {
        return json({ message: 'Temporary archive failure' }, 500);
      }
      const zip = new AdmZip();
      zip.addFile(
        `project-main/${this.options.archivedFileName ?? 'uploaded.txt'}`,
        Buffer.from('uploaded content'),
      );
      zip.addFile('project-main/other.txt', Buffer.from('other content'));
      zip.addFile('project-main/docs/readme.md', Buffer.from('# docs'));
      const bytes = zip.toBuffer();
      return new Response(Uint8Array.from(bytes), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(bytes.length),
        },
      });
    }

    return json({ message: `Unexpected request ${method} ${parsed.pathname}` }, 404);
  }

  private branchTip(): string {
    if (this.options.branchTipCommitId) {
      return this.options.branchTipCommitId;
    }
    return this.uploaded ? 'commit-1' : 'base-commit';
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-task-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeController(
  root: string,
  saveDirectory: string,
  fake: HttpTransport,
  options: {
    maxUploadBytes?: number;
    readFileContent?: TaskControllerOptions['readFileContent'];
  } = {},
): TaskController {
  const config: AppConfig = {
    ...createDefaultConfig(),
    gitlabUrl: 'https://gitlab.example.com',
    projectId: 'group/project',
    saveDirectory,
    ...(options.maxUploadBytes
      ? { maxUploadBytes: options.maxUploadBytes }
      : {}),
  };
  return new TaskController({
    transport: fake,
    getConfig: async () => config,
    getToken: async () => 'glpat-test',
    getDocumentsDirectory: () => root,
    getTemporaryDirectory: () => root,
    clientBranchNamespace: CLIENT_NAMESPACE,
    ...(options.readFileContent
      ? { readFileContent: options.readFileContent }
      : {}),
  });
}
