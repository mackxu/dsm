import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  envFile: path.join(PROJECT_ROOT, '.env'),
  file: '/Users/duoduoxu/Downloads/居住证(卡)确认单.pdf',
  extractBase: '/Users/duoduoxu/Downloads/gitlab-test',
} as const;

export interface Config {
  baseUrl: string;
  token: string;
  projectId: string;
  branch: string;
  filePath: string;
  extractBase: string;
}

interface CliOptions {
  envFile: string;
  file: string;
  extractBase: string;
  branch?: string;
  project?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    envFile: DEFAULTS.envFile,
    file: DEFAULTS.file,
    extractBase: DEFAULTS.extractBase,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    if (!argument.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const equalsIndex = argument.indexOf('=');
    const name = equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex);
    const value = equalsIndex === -1 ? argv[++index] : argument.slice(equalsIndex + 1);

    if (!value) {
      throw new Error(`Missing value for --${name}`);
    }

    switch (name) {
      case 'env-file':
        options.envFile = value;
        break;
      case 'file':
        options.file = value;
        break;
      case 'extract-base':
        options.extractBase = value;
        break;
      case 'branch':
        options.branch = value;
        break;
      case 'project':
        options.project = value;
        break;
      default:
        throw new Error(`Unknown option: --${name}`);
    }
  }

  return options;
}

export function showHelp(): void {
  console.log(`Usage: npx tsx src/gitlab-sync.ts [options]

Options:
  --file <path>          File to upload (default: ${DEFAULTS.file})
  --extract-base <path>  Base extraction directory (default: ${DEFAULTS.extractBase})
  --branch <name>        GitLab branch (default: BRANCH_NAME from .env)
  --project <id>         GitLab project ID (default: PROJECT_ID from .env)
  --env-file <path>      Environment file (default: ./.env)
  --help                 Show this help

Each run creates a timestamped extraction directory, for example:
  ${DEFAULTS.extractBase}/20261102-161500-123`);
}

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const originalLine of contents.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

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

export async function loadConfig(options: CliOptions): Promise<Config> {
  const envFile = path.resolve(options.envFile);
  let envContents: string;

  try {
    envContents = await fs.readFile(envFile, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read environment file ${envFile}: ${message}`);
  }

  const env = { ...parseEnvFile(envContents), ...process.env };
  const config: Config = {
    baseUrl: (env.GITLAB_URL ?? '').replace(/\/+$/, ''),
    token: env.GIT_TOKEN ?? '',
    projectId: options.project ?? env.PROJECT_ID ?? '',
    branch: options.branch ?? env.BRANCH_NAME ?? 'main',
    filePath: path.resolve(options.file),
    extractBase: path.resolve(options.extractBase),
  };

  const required: Array<[string, string]> = [
    ['GITLAB_URL', config.baseUrl],
    ['GIT_TOKEN', config.token],
    ['PROJECT_ID', config.projectId],
    ['BRANCH_NAME', config.branch],
  ];

  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`${name} is missing from ${envFile}`);
    }
  }

  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`GITLAB_URL must use HTTP or HTTPS: ${config.baseUrl}`);
  }

  return config;
}

export async function validateLocalInputs(config: Config): Promise<void> {
  const fileStat = await fs.stat(config.filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Upload file does not exist or is not a regular file: ${config.filePath}`);
  }

  await fs.mkdir(config.extractBase, { recursive: true });
}
