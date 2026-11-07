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

export {
  minimalEnvironment,
  normalizeCommand,
  queryExecutableVersion,
} from './reader-executable.ts';

const NODE_SPEC: ReaderSpec = {
  kind: 'node',
  label: 'Node',
  envVar: 'DSM_NODE_PATH',
  versionArgs: ['-p', 'process.versions.node'],
  versionPattern: /^\d+\.\d+\.\d+$/,
  candidates: nodeCandidates,
};

export class NodeExecutableResolver extends ReaderExecutableResolver {
  constructor() {
    super(NODE_SPEC);
  }
}

async function nodeCandidates(): Promise<string[]> {
  const result: string[] = [];
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';

  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory) {
      result.push(path.join(directory, executableName));
    }
  }

  if (process.platform === 'win32') {
    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
      const base = process.env[variable];
      if (base) {
        result.push(path.join(base, 'nodejs', executableName));
      }
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      result.push(
        path.join(localAppData, 'Programs', 'nodejs', executableName),
      );
    }
    const appData = process.env.APPDATA;
    if (appData) {
      result.push(path.join(appData, 'nvm', executableName));
    }
  } else {
    result.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
    );
    const nvmDirectory = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    const versionsDirectory = path.join(nvmDirectory, 'versions', 'node');
    const entries = await fs
      .readdir(versionsDirectory)
      .catch(() => [] as string[]);
    for (const entry of entries.sort().reverse()) {
      result.push(path.join(versionsDirectory, entry, 'bin', 'node'));
    }
  }

  return [...new Set(result)];
}
