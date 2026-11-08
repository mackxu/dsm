import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDefaultConfig,
  extractArchive,
  GitLabClient,
  resolveClientBranchNamespace,
  validateAppConfig,
  type HttpTransport,
} from '../packages/core/src/index.ts';

const env = await readEnvironment(path.resolve('.env'));
const commitId = process.env.DSM_SMOKE_COMMIT_ID?.trim() ?? '';
const fileName =
  process.env.DSM_SMOKE_FILE_NAME?.trim() || 'dsm-smoke-20261105-150900.txt';
if (!env.GITLAB_URL || !env.PROJECT_ID || !env.GIT_TOKEN || !commitId) {
  throw new Error('Missing GitLab recovery test configuration');
}

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'dsm-recovery-smoke-'),
);
const timestamp = `recovery-${Date.now()}`;
const archivePath = path.join(
  workspace,
  `gitlab-project-recover-${timestamp}.zip`,
);
const temporaryArchivePath = path.join(workspace, `.dsm-${timestamp}.zip.part`);
const config = validateAppConfig(
  {
    ...createDefaultConfig(),
    gitlabUrl: env.GITLAB_URL,
    projectId: env.PROJECT_ID,
    saveDirectory: workspace,
  },
  { requireRemote: true },
);
const transport: HttpTransport = {
  request: (url, options) => fetch(url, options),
};
const clientBranchNamespace =
  process.env.DSM_CLIENT_BRANCH?.trim() ||
  resolveClientBranchNamespace({
    username: os.userInfo().username,
    hostname: os.hostname(),
  });
const client = GitLabClient.fromConfig(
  config,
  env.GIT_TOKEN,
  transport,
  `${clientBranchNamespace}/recovery-${timestamp}`,
);
const download = await client.downloadArchive(
  commitId,
  archivePath,
  config.archiveLimits,
  temporaryArchivePath,
);
const extraction = await extractArchive(
  download.archivePath,
  workspace,
  timestamp,
  {
    limits: config.archiveLimits,
    requiredRelativePath: fileName,
    onlyRelativePath: fileName,
  },
);
const extractedPath = path.join(extraction.finalDirectory, fileName);
const content = await fs.readFile(extractedPath, 'utf8');

console.log(
  JSON.stringify(
    {
      commitId,
      fileName,
      archivePath: download.archivePath,
      archiveSize: download.archiveSize,
      resultDirectory: extraction.finalDirectory,
      extractedFiles: extraction.extractedFiles.map((entry) =>
        path.relative(extraction.finalDirectory, entry),
      ),
      extractedBytes: Buffer.byteLength(content),
      contentPrefixMatches: content.startsWith('DSM live GitLab smoke test'),
      partFileExists: Boolean(
        await fs.stat(temporaryArchivePath).catch(() => null),
      ),
    },
    null,
    2,
  ),
);

if (!content.startsWith('DSM live GitLab smoke test')) {
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
