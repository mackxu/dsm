import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDefaultConfig,
  resolveClientBranchNamespace,
  TaskController,
  validateAppConfig,
  type HttpTransport,
  type TaskSnapshot,
} from '../packages/core/src/index.ts';

const fileName =
  process.env.DSM_SMOKE_FILE_NAME?.trim() || `dsm-smoke-${Date.now()}.txt`;
const env = await readEnvironment(path.resolve('.env'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-live-smoke-'));
const sourcePath = path.join(workspace, fileName);
const saveDirectory = path.join(workspace, 'results');
const content = [
  'DSM live GitLab smoke test',
  `createdAt=${new Date().toISOString()}`,
  `fileName=${fileName}`,
  '',
].join('\n');
await fs.writeFile(sourcePath, content, 'utf8');

const config = validateAppConfig(
  {
    ...createDefaultConfig(),
    gitlabUrl: env.GITLAB_URL,
    projectId: env.PROJECT_ID,
    saveDirectory,
    keepArchive: true,
  },
  { requireRemote: true },
);
const clientBranchNamespace =
  process.env.DSM_CLIENT_BRANCH?.trim() ||
  resolveClientBranchNamespace({
    username: os.userInfo().username,
    hostname: os.hostname(),
  });
const token = env.GIT_TOKEN?.trim() ?? '';
if (!token) {
  throw new Error('GIT_TOKEN is missing from .env');
}

const transport: HttpTransport = {
  request: (url, options) => fetch(url, options),
};
const states: Array<{
  status: TaskSnapshot['status'];
  stage: TaskSnapshot['stage'];
}> = [];
const controller = new TaskController({
  transport,
  getConfig: async () => config,
  getToken: async () => token,
  getDocumentsDirectory: () => workspace,
  getTemporaryDirectory: () => workspace,
  clientBranchNamespace,
  onUpdate: (snapshot) => {
    const previous = states.at(-1);
    if (
      previous?.status !== snapshot.status ||
      previous?.stage !== snapshot.stage
    ) {
      states.push({ status: snapshot.status, stage: snapshot.stage });
    }
  },
});

let task = await controller.start(sourcePath);
if (task.status === 'WAITING_FOR_OVERWRITE_CONFIRMATION') {
  task = await controller.confirm(task.taskId, { allowOverwrite: true });
}
const extractedPath = task.resultDirectory
  ? path.join(task.resultDirectory, fileName)
  : null;
const extractedContent = extractedPath
  ? await fs.readFile(extractedPath, 'utf8').catch(() => null)
  : null;
const archiveStat = task.archivePath
  ? await fs.stat(task.archivePath).catch(() => null)
  : null;

console.log(
  JSON.stringify(
    {
      status: task.status,
      fileName,
      commitId: task.commitId,
      branch: task.branch,
      baseBranch: task.sourceBranch,
      remotePath: task.remotePath,
      resultDirectory: task.resultDirectory,
      archivePath: task.archivePath,
      archiveSize: archiveStat?.size ?? null,
      extractedFileExists: Boolean(extractedContent !== null),
      extractedContentMatches: extractedContent === content,
      states,
      failure: task.failure,
    },
    null,
    2,
  ),
);

if (
  task.status !== 'SUCCESS' ||
  !task.commitId ||
  extractedContent !== content ||
  !archiveStat
) {
  process.exitCode = 1;
}

async function readEnvironment(
  filePath: string,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const contents = await fs.readFile(filePath, 'utf8');
  for (const originalLine of contents.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
