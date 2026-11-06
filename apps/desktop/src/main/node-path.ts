import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DsmError } from '@dsm/core';

export type NodeSource = 'config' | 'environment' | 'auto';

export interface ResolvedNode {
  command: string;
  version: string;
  source: NodeSource;
}

const VERSION_QUERY_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_CHARS = 100;

/**
 * 解析用于读取受 DSM 管控文件的 Node 可执行文件。
 *
 * 优先使用用户配置的路径，其次使用 DSM_NODE_PATH，最后自动探测。
 * 显式配置但不可执行时抛错，避免静默回退导致上传密文；自动探测
 * 失败时返回 null，由调用方决定是否回退主进程直读。
 */
export class NodeExecutableResolver {
  private readonly cache = new Map<string, ResolvedNode>();
  private autoResolved: ResolvedNode | null | undefined;

  async resolve(configuredPath: string | null): Promise<ResolvedNode | null> {
    const fromConfig = normalizeCommand(configuredPath ?? '');
    const fromEnvironment = normalizeCommand(process.env.DSM_NODE_PATH ?? '');

    if (fromConfig) {
      return this.requireExecutable(fromConfig, 'config');
    }
    if (fromEnvironment) {
      return this.requireExecutable(fromEnvironment, 'environment');
    }

    if (this.autoResolved !== undefined) {
      return this.autoResolved;
    }
    for (const candidate of await this.candidates()) {
      const resolved = await this.tryExecutable(candidate, 'auto');
      if (resolved) {
        this.autoResolved = resolved;
        return resolved;
      }
    }
    this.autoResolved = null;
    return null;
  }

  private async requireExecutable(
    command: string,
    source: NodeSource,
  ): Promise<ResolvedNode> {
    const resolved = await this.tryExecutable(command, source);
    if (!resolved) {
      throw new DsmError(
        'READER_UNAVAILABLE',
        `无法执行 DSM 读取 Node：${command}`,
        'CHECK',
      );
    }
    return resolved;
  }

  private async tryExecutable(
    command: string,
    source: NodeSource,
  ): Promise<ResolvedNode | null> {
    const cached = this.cache.get(command);
    if (cached) {
      return { ...cached, source };
    }
    const version = await queryNodeVersion(command);
    if (!version) return null;
    const resolved: ResolvedNode = { command, version, source };
    this.cache.set(command, resolved);
    return resolved;
  }

  private async candidates(): Promise<string[]> {
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
      const nvmDirectory =
        process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
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
}

export function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'ComSpec',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function normalizeCommand(value: string): string {
  let command = value.trim();
  if (
    command.length >= 2 &&
    ((command.startsWith('"') && command.endsWith('"')) ||
      (command.startsWith("'") && command.endsWith("'")))
  ) {
    command = command.slice(1, -1).trim();
  }
  if (command === '~') {
    return os.homedir();
  }
  if (command.startsWith('~/') || command.startsWith('~\\')) {
    return path.join(os.homedir(), command.slice(2));
  }
  return command;
}

function queryNodeVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (version: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(version);
    };

    const child = spawn(command, ['-p', 'process.versions.node'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
      env: minimalEnvironment(),
    });

    let output = '';
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, VERSION_QUERY_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < MAX_VERSION_OUTPUT_CHARS) {
        output += chunk.toString('utf8');
      }
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      const version = output.trim();
      finish(code === 0 && /^\d+\.\d+\.\d+$/.test(version) ? version : null);
    });
  });
}
