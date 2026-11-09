import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ReaderExecutableResolver,
  type ReaderSpec,
} from './reader-executable.ts';

const MINIMUM_PYTHON_MINOR = 8;

export interface PythonCandidateContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const PYTHON_SPEC: ReaderSpec = {
  kind: 'python',
  label: 'Python',
  envVar: 'DSM_PYTHON_PATH',
  versionArgs: [
    '-I',
    '-S',
    '-B',
    '-c',
    "import sys; print('%d.%d.%d' % sys.version_info[:3])",
  ],
  versionPattern: /^3\.(\d+)\.(\d+)$/,
  validateVersion: isSupportedPythonVersion,
  candidates: () => pythonCandidates(),
  validateCommand: async (command) => {
    const realPath = await fs.realpath(command).catch(() => command);
    return !isWindowsAppsPath(realPath);
  },
};

export class PythonExecutableResolver extends ReaderExecutableResolver {
  constructor() {
    super(PYTHON_SPEC);
  }
}

export function isSupportedPythonVersion(version: string): boolean {
  const match = /^3\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return false;
  }
  return Number(match[1]) >= MINIMUM_PYTHON_MINOR;
}

export async function pythonCandidates(
  context: PythonCandidateContext = {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
  },
): Promise<string[]> {
  const isWindows = context.platform === 'win32';
  const join = path.join;
  // DSM 白名单可能只匹配 python（或 python.exe），因此先尝试所有目录下的
  // python 候选，只有都不可用时才用 python3 兜底。
  const commandNames = isWindows
    ? ['python.exe', 'python3.exe']
    : ['python', 'python3'];
  const directories = await pythonDirectories(context);

  const result: string[] = [];
  for (const name of commandNames) {
    for (const directory of directories) {
      result.push(join(directory, name));
    }
  }
  return deduplicate(result, isWindows);
}

async function pythonDirectories(
  context: PythonCandidateContext,
): Promise<string[]> {
  const isWindows = context.platform === 'win32';
  const isMac = context.platform === 'darwin';
  const join = path.join;
  const delimiter = isWindows ? ';' : ':';
  const localAppData = context.env.LOCALAPPDATA;
  const directories: string[] = [];

  for (const rawDirectory of (context.env.PATH ?? '').split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    if (isWindows && isWindowsAppsPath(directory)) continue;
    if (isMac && directory === '/usr/bin') continue;
    if (isMac && directory === join(context.home, '.pyenv', 'shims')) continue;
    directories.push(directory);
  }

  if (isWindows) {
    if (localAppData) {
      directories.push(
        ...(await versionedDirectories(
          join(localAppData, 'Programs', 'Python'),
          (name) => /^Python3\d+$/.test(name),
          pythonDirectoryScore,
          (base, name) => join(base, name),
        )),
      );
    }

    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
      const base = context.env[variable];
      if (!base) continue;
      directories.push(
        ...(await versionedDirectories(
          base,
          (name) => /^Python3\d+$/.test(name),
          pythonDirectoryScore,
          (directory, name) => join(directory, name),
        )),
      );
    }

    for (const conda of ['miniconda3', 'anaconda3']) {
      const userProfile = context.env.USERPROFILE;
      if (userProfile) {
        directories.push(join(userProfile, conda));
      }
      if (localAppData) {
        directories.push(join(localAppData, conda));
      }
    }
  } else if (isMac) {
    directories.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Library/Developer/CommandLineTools/usr/bin',
    );
    for (const base of [
      '/Library/Frameworks/Python.framework/Versions',
      join(context.home, '.pyenv', 'versions'),
    ]) {
      directories.push(
        ...(await versionedDirectories(
          base,
          (name) => /^3\.\d+/.test(name),
          numericVersionScore,
          (directory, name) => join(directory, name, 'bin'),
        )),
      );
    }
  } else {
    directories.push('/usr/bin', '/usr/local/bin');
  }

  return directories;
}

async function versionedDirectories(
  base: string,
  include: (name: string) => boolean,
  score: (name: string) => number,
  toDirectory: (base: string, name: string) => string,
): Promise<string[]> {
  const entries = await fs
    .readdir(base, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && include(entry.name))
    .sort(
      (a, b) => score(b.name) - score(a.name) || b.name.localeCompare(a.name),
    )
    .map((entry) => toDirectory(base, entry.name));
}

function pythonDirectoryScore(name: string): number {
  const match = /^Python3(\d+)$/.exec(name);
  return match ? Number(match[1]) : -1;
}

function numericVersionScore(name: string): number {
  const parts = name.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return major * 1_000_000 + minor * 1_000 + patch;
}

function isWindowsAppsPath(value: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(value);
}

function deduplicate(values: string[], caseInsensitive: boolean): string[] {
  if (!caseInsensitive) {
    return [...new Set(values)];
  }
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
