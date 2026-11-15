import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReaderSource } from '@dsm/core';

import {
  ReaderExecutableResolver,
  type ReaderSpec,
  type ResolvedReader,
} from './reader-executable.ts';

export type NodeSource = ReaderSource;
export type ResolvedNode = ResolvedReader;

export interface NodeCandidateContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const NODE_SPEC: ReaderSpec = {
  kind: 'node',
  label: 'Node',
  envVar: 'DSM_NODE_PATH',
  versionArgs: ['-p', 'process.versions.node'],
  versionPattern: /^\d+\.\d+\.\d+$/,
  candidates: () => nodeCandidates(),
};

export class NodeExecutableResolver extends ReaderExecutableResolver {
  constructor() {
    super(NODE_SPEC);
  }
}

/**
 * 生成 Node 候选路径。
 *
 * 顺序：PATH → fnm（multishell / default 别名 / 已安装版本）→ Volta →
 * 系统安装目录 / nvm。候选是否可用仍由 ReaderExecutableResolver 逐个
 * 执行版本命令验证。
 */
export async function nodeCandidates(
  context: NodeCandidateContext = {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
  },
): Promise<string[]> {
  const isWindows = context.platform === 'win32';
  const executableName = isWindows ? 'node.exe' : 'node';
  const fnmNodePath = isWindows
    ? executableName
    : path.join('bin', executableName);
  const join = path.join;
  const delimiter = isWindows ? ';' : ':';
  const result: string[] = [];

  for (const rawDirectory of (context.env.PATH ?? '').split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (directory) {
      result.push(join(directory, executableName));
    }
  }

  const fnmDir = context.env.FNM_DIR || defaultFnmDirectory(context);
  if (fnmDir) {
    const multishell = context.env.FNM_MULTISHELL_PATH;
    if (multishell) {
      result.push(join(multishell, fnmNodePath));
    }
    result.push(join(fnmDir, 'aliases', 'default', fnmNodePath));
    result.push(...(await fnmVersionCandidates(fnmDir, fnmNodePath)));
  }

  if (isWindows) {
    const localAppData = context.env.LOCALAPPDATA;
    if (localAppData) {
      result.push(join(localAppData, 'Volta', 'bin', executableName));
    }
    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
      const base = context.env[variable];
      if (base) {
        result.push(join(base, 'nodejs', executableName));
      }
    }
    if (localAppData) {
      result.push(join(localAppData, 'Programs', 'nodejs', executableName));
    }
    const appData = context.env.APPDATA;
    if (appData) {
      result.push(join(appData, 'nvm', executableName));
    }
  } else {
    const voltaHome = context.env.VOLTA_HOME || join(context.home, '.volta');
    result.push(join(voltaHome, 'bin', 'node'));
    result.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
    );
    const nvmDirectory = context.env.NVM_DIR || join(context.home, '.nvm');
    const versionsDirectory = join(nvmDirectory, 'versions', 'node');
    const entries = await fs
      .readdir(versionsDirectory)
      .catch(() => [] as string[]);
    for (const entry of entries.sort().reverse()) {
      result.push(join(versionsDirectory, entry, 'bin', 'node'));
    }
  }

  return deduplicate(result, isWindows);
}

function defaultFnmDirectory(context: NodeCandidateContext): string | null {
  if (context.platform === 'win32') {
    return context.env.APPDATA ? path.join(context.env.APPDATA, 'fnm') : null;
  }
  if (context.platform === 'darwin') {
    return path.join(context.home, 'Library', 'Application Support', 'fnm');
  }
  return context.env.XDG_DATA_HOME
    ? path.join(context.env.XDG_DATA_HOME, 'fnm')
    : path.join(context.home, '.local', 'share', 'fnm');
}

async function fnmVersionCandidates(
  fnmDir: string,
  relativeNodePath: string,
): Promise<string[]> {
  const versionsDirectory = path.join(fnmDir, 'node-versions');
  const entries = await fs
    .readdir(versionsDirectory, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter(
      (entry) => entry.isDirectory() && /^v?\d+\.\d+\.\d+/.test(entry.name),
    )
    .sort(
      (left, right) =>
        nodeVersionScore(right.name) - nodeVersionScore(left.name) ||
        right.name.localeCompare(left.name),
    )
    .map((entry) =>
      path.join(
        versionsDirectory,
        entry.name,
        'installation',
        relativeNodePath,
      ),
    );
}

function nodeVersionScore(name: string): number {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!match) return -1;
  return (
    Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3])
  );
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
