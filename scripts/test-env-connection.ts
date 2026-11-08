import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASE_BRANCH_NAME,
  createDefaultConfig,
  GitLabClient,
  resolveClientBranchNamespace,
  validateAppConfig,
  type HttpTransport,
} from '../packages/core/src/index.ts';

const env = await readEnvironment(path.resolve('.env'));
const config = validateAppConfig(
  {
    ...createDefaultConfig(),
    gitlabUrl: env.GITLAB_URL,
    projectId: env.PROJECT_ID,
  },
  { requireRemote: true },
);
const token = env.GIT_TOKEN?.trim() ?? '';

if (!token) {
  throw new Error('GIT_TOKEN is missing from .env');
}

const clientBranchNamespace =
  process.env.DSM_CLIENT_BRANCH?.trim() ||
  resolveClientBranchNamespace({
    username: os.userInfo().username,
    hostname: os.hostname(),
  });
const probeBranch = `${clientBranchNamespace}/probe-${Date.now()}`;

let transportError: unknown;
const transport: HttpTransport = {
  request: async (url, options) => {
    try {
      return await fetch(url, options);
    } catch (error) {
      transportError = error;
      throw error;
    }
  },
};
const client = GitLabClient.fromConfig(
  config,
  token,
  transport,
  probeBranch,
);
let result;
try {
  result = await client.testConnection();
} catch (error) {
  const target = new URL(config.gitlabUrl);
  console.error(
    JSON.stringify(
      {
        connectionFailed: true,
        protocol: target.protocol,
        hostKind: classifyHost(target.hostname),
        customPort: Boolean(target.port),
        apiPathPrefix: target.pathname !== '/',
        error: describeError(transportError ?? error),
        proxyConfigured: Boolean(
          process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy,
        ),
        customCaConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  result = null;
}

if (!result) {
  process.exit();
}

const smokeFileName = process.env.DSM_SMOKE_FILE_NAME?.trim() ?? '';
const preparation = smokeFileName
  ? await client.prepareUpload(smokeFileName)
  : null;

console.log(
  JSON.stringify(
    {
      user: result.user.username,
      userId: result.user.id,
      project: result.project.path_with_namespace,
      projectId: result.project.id,
      clientBranchNamespace,
      probeBranch,
      baseBranch: BASE_BRANCH_NAME,
      baseBranchExists: Boolean(result.baseBranch),
      defaultBranch: result.project.default_branch,
      emptyRepository: result.project.empty_repo,
      ...(preparation
        ? {
            smokeFileName,
            remoteFileExists: preparation.file.exists,
            lastCommitPresent: Boolean(preparation.file.lastCommitId),
          }
        : {}),
    },
    null,
    2,
  ),
);

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

function classifyHost(hostname: string): string {
  if (hostname === 'localhost') return 'localhost';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
      ? 'private-ip'
      : 'public-ip';
  }
  return hostname.includes('.') ? 'dns-hostname' : 'internal-hostname';
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const cause =
    'cause' in error && error.cause instanceof Error
      ? {
          name: error.cause.name,
          message: error.cause.message,
          code: 'code' in error.cause ? String(error.cause.code) : undefined,
        }
      : undefined;
  return {
    name: error.name,
    message: error.message,
    cause,
  };
}
