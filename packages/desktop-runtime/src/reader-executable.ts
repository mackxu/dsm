import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { DsmError, type ReaderKind, type ReaderSource } from '@dsm/core';

export interface ResolvedReader {
  kind: ReaderKind;
  command: string;
  version: string;
  source: ReaderSource;
}

export interface ReaderResolver {
  readonly kind: ReaderKind;
  /**
   * 解析读取器。
   *
   * 只有“没有显式配置且自动探测完全失败”时返回 null；显式配置的路径
   * 不可执行时必须抛 READER_UNAVAILABLE，不能静默回退。
   */
  resolve(configuredPath: string | null): Promise<ResolvedReader | null>;
  resetAutoDetection(): void;
}

export interface ReaderSpec {
  kind: ReaderKind;
  label: string;
  envVar: string;
  versionArgs: string[];
  versionPattern: RegExp;
  validateVersion?: (version: string) => boolean;
  candidates: () => Promise<string[]>;
  /** 仅用于自动探测结果，例如排除 Windows Store 别名。 */
  validateCommand?: (command: string) => Promise<boolean>;
}

const VERSION_QUERY_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_CHARS = 100;

/**
 * 通用的 DSM 读取器可执行文件解析器。
 *
 * 优先级：配置路径 → 环境变量 → 自动探测。显式配置不可执行时抛错；
 * 自动探测失败时返回 null，由调用方决定是否尝试另一个读取器。
 */
export class ReaderExecutableResolver implements ReaderResolver {
  private readonly cache = new Map<string, ResolvedReader>();
  private autoResolved: ResolvedReader | null | undefined;

  constructor(private readonly spec: ReaderSpec) {}

  get kind(): ReaderKind {
    return this.spec.kind;
  }

  async resolve(configuredPath: string | null): Promise<ResolvedReader | null> {
    const fromConfig = normalizeCommand(configuredPath ?? '');
    if (fromConfig) {
      return this.requireExecutable(fromConfig, 'config');
    }

    const fromEnvironment = normalizeCommand(
      process.env[this.spec.envVar] ?? '',
    );
    if (fromEnvironment) {
      return this.requireExecutable(fromEnvironment, 'environment');
    }

    if (this.autoResolved !== undefined) {
      return this.autoResolved;
    }
    for (const candidate of await this.spec.candidates()) {
      const resolved = await this.tryExecutable(candidate, 'auto');
      if (resolved) {
        this.autoResolved = resolved;
        return resolved;
      }
    }
    this.autoResolved = null;
    return null;
  }

  resetAutoDetection(): void {
    this.autoResolved = undefined;
  }

  reset(): void {
    this.cache.clear();
    this.autoResolved = undefined;
  }

  private async requireExecutable(
    command: string,
    source: ReaderSource,
  ): Promise<ResolvedReader> {
    const resolved = await this.tryExecutable(command, source);
    if (!resolved) {
      throw new DsmError(
        'READER_UNAVAILABLE',
        `前置依赖不可执行：${command}。显式配置失败不会回退。`,
        'CHECK',
      );
    }
    return resolved;
  }

  private async tryExecutable(
    command: string,
    source: ReaderSource,
  ): Promise<ResolvedReader | null> {
    const cached = this.cache.get(command);
    if (cached) {
      return { ...cached, source };
    }

    if (
      source === 'auto' &&
      this.spec.validateCommand &&
      !(await this.spec.validateCommand(command))
    ) {
      return null;
    }

    const version = await queryExecutableVersion(
      command,
      this.spec.versionArgs,
      this.spec.versionPattern,
      this.spec.validateVersion,
    );
    if (!version) {
      return null;
    }

    const resolved: ResolvedReader = {
      kind: this.spec.kind,
      command,
      version,
      source,
    };
    this.cache.set(command, resolved);
    return resolved;
  }
}

export function queryExecutableVersion(
  command: string,
  args: string[],
  pattern: RegExp,
  validate?: (version: string) => boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (version: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(version);
    };

    const child = spawn(command, args, {
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
      finish(
        code === 0 && pattern.test(version) && (!validate || validate(version))
          ? version
          : null,
      );
    });
  });
}

export function minimalEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function normalizeCommand(value: string): string {
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
