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
} from '@dsm/core';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('TaskController with fake GitLab', () => {
  it('uploads once, locates the task commit, and extracts that archive', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab(root);
    const config: AppConfig = {
      ...createDefaultConfig(),
      gitlabUrl: 'https://gitlab.example.com',
      projectId: 'group/project',
      branch: 'main',
      saveDirectory,
      keepArchive: false,
    };
    const controller = new TaskController({
      transport: fake,
      getConfig: async () => config,
      getToken: async () => 'glpat-test',
      getDocumentsDirectory: () => root,
      getTemporaryDirectory: () => root,
    });

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(task.commitId).toBe('commit-1');
    expect(fake.uploadCount).toBe(1);
    expect(fake.archiveShas).toEqual(['commit-1']);
    expect(fake.archiveModes).toEqual(['same-origin']);
    expect(
      await fs.readFile(path.join(task.resultDirectory as string, 'uploaded.txt'), 'utf8'),
    ).toBe('uploaded content');
    expect(task.archivePath).toBeNull();
  });

  it('does not create a final result directory when the archive lacks the file', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab(root, { archivedFileName: 'different.txt' });
    const config: AppConfig = {
      ...createDefaultConfig(),
      gitlabUrl: 'https://gitlab.example.com',
      projectId: 'group/project',
      saveDirectory,
    };
    const controller = new TaskController({
      transport: fake,
      getConfig: async () => config,
      getToken: async () => 'glpat-test',
      getDocumentsDirectory: () => root,
      getTemporaryDirectory: () => root,
    });

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('FAILED');
    expect(task.failure?.stage).toBe('EXTRACT');
    const names = await fs.readdir(saveDirectory);
    expect(names.filter((name) => !name.endsWith('.zip'))).toEqual([]);
  });

  it('uses last_commit_id after the user confirms an overwrite', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'updated content');
    const fake = new FakeGitLab(root, {
      fileExists: true,
      lastCommitId: 'previous-commit',
    });
    const controller = makeController(root, sourcePath, saveDirectory, fake);

    const waiting = await controller.start(sourcePath);
    expect(waiting.status).toBe('WAITING_FOR_OVERWRITE_CONFIRMATION');
    expect(fake.uploadCount).toBe(0);

    const task = await controller.confirm(waiting.taskId, {
      allowOverwrite: true,
    });
    expect(task.status).toBe('SUCCESS');
    expect(fake.lastUploadBody?.last_commit_id).toBe('previous-commit');
    expect(fake.lastUploadMethod).toBe('PUT');
  });

  it('creates a missing branch only after confirmation', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab(root, { branchExists: false });
    const controller = makeController(root, sourcePath, saveDirectory, fake);

    const waiting = await controller.start(sourcePath);
    expect(waiting.status).toBe('WAITING_FOR_BRANCH_CONFIRMATION');
    expect(fake.branchCreateCount).toBe(0);

    const task = await controller.confirm(waiting.taskId, {
      allowCreateBranch: true,
    });
    expect(task.status).toBe('SUCCESS');
    expect(task.branchCreated).toBe(true);
    expect(fake.branchCreateCount).toBe(1);
  });

  it('queries by task marker after an ambiguous upload failure without re-uploading', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = path.join(root, 'uploaded.txt');
    const saveDirectory = path.join(root, 'results');
    await fs.writeFile(sourcePath, 'uploaded content');
    const fake = new FakeGitLab(root, {
      uploadStatus: 500,
      commitVisibleAfterFailure: true,
    });
    const controller = makeController(root, sourcePath, saveDirectory, fake);

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
    const fake = new FakeGitLab(root, {
      uploadStatus: 500,
      commitVisibleAfterFailure: false,
    });
    const controller = makeController(root, sourcePath, saveDirectory, fake);

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
    const fake = new FakeGitLab(root, { archiveFailures: 1 });
    const controller = makeController(root, sourcePath, saveDirectory, fake);

    const task = await controller.start(sourcePath);

    expect(task.status).toBe('SUCCESS');
    expect(fake.archiveShas).toEqual(['commit-1', 'commit-1']);
  });
});

interface FakeGitLabOptions {
  archivedFileName?: string;
  fileExists?: boolean;
  lastCommitId?: string;
  branchExists?: boolean;
  uploadStatus?: number;
  commitVisibleAfterFailure?: boolean;
  archiveFailures?: number;
}

class FakeGitLab implements HttpTransport {
  uploadCount = 0;
  branchCreateCount = 0;
  archiveShas: string[] = [];
  archiveModes: Array<RequestInit['mode']> = [];
  lastUploadBody: Record<string, unknown> | null = null;
  lastUploadMethod = '';
  private marker = '';
  private uploaded = false;
  private branchExists: boolean;
  private archiveAttempts = 0;

  constructor(
    private readonly temporaryRoot: string,
    private readonly options: FakeGitLabOptions = {},
  ) {
    this.branchExists = options.branchExists ?? true;
  }

  async request(url: string, options: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url);
    const method = options.method ?? 'GET';

    if (method === 'GET' && parsed.pathname.endsWith('/projects/group%2Fproject')) {
      return json({
        id: 12,
        path_with_namespace: 'group/project',
        default_branch: 'main',
        empty_repo: false,
      });
    }
    if (
      method === 'GET' &&
      parsed.pathname.endsWith('/repository/branches/main')
    ) {
      return this.branchExists
        ? json({ name: 'main', default: true, protected: false })
        : json({ message: '404 Branch Not Found' }, 404);
    }
    if (
      method === 'GET' &&
      parsed.pathname.endsWith('/repository/branches')
    ) {
      return json([{ name: 'main', default: true, protected: false }]);
    }
    if (
      method === 'POST' &&
      parsed.pathname.endsWith('/repository/branches')
    ) {
      this.branchCreateCount += 1;
      this.branchExists = true;
      return json({ name: 'main', default: true, protected: false }, 201);
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
      return json({ file_path: 'uploaded.txt', branch: 'main' }, 201);
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
      this.archiveShas.push(parsed.searchParams.get('sha') ?? '');
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
  sourcePath: string,
  saveDirectory: string,
  fake: HttpTransport,
): TaskController {
  const config: AppConfig = {
    ...createDefaultConfig(),
    gitlabUrl: 'https://gitlab.example.com',
    projectId: 'group/project',
    branch: 'main',
    saveDirectory,
  };
  return new TaskController({
    transport: fake,
    getConfig: async () => config,
    getToken: async () => 'glpat-test',
    getDocumentsDirectory: () => root,
    getTemporaryDirectory: () => root,
  });
}
