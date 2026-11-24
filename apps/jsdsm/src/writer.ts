import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { JsdsmError, errorMessage } from './errors.ts';

export type WriterSource = 'option' | 'environment' | 'auto';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+){0,3}$/;
const VERSION_QUERY_TIMEOUT_MS = 5_000;
const ENVIRONMENT_KEYS = [
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
] as const;

export interface ResolvedPowerShell {
  command: string;
  version: string;
  source: WriterSource;
}

export interface WriteResult {
  bytesWritten: number;
  sha256: string;
  tempPath: string;
}

export interface WriteSession {
  stdin: Writable;
  completed: Promise<WriteResult>;
  abort(): void;
}

export interface OpenOptions {
  timeoutMs?: number;
}

export interface WriterLike {
  open(
    targetDirectory: string,
    fileName: string,
    tempName: string,
    options?: OpenOptions,
  ): Promise<WriteSession>;
}

export interface PowerShellWriterOptions {
  helperPath: string;
  configuredPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  queryVersion?: (command: string) => Promise<string | null>;
  candidates?: () => string[];
}

export function defaultWriterHelperPath(): string {
  return fileURLToPath(
    new URL('./resources/dsm-file-writer.ps1', import.meta.url),
  );
}

/**
 * 通过白名单 PowerShell 写入明文。
 *
 * 解析顺序：--writer-path → JSDSM_WRITER_PATH → 自动探测。显式路径不可
 * 执行时直接报错，不回退。写入代理只创建并写入目标目录下的 .part 文件，
 * 最终 rename 由调用方完成。
 */
export class PowerShellWriter implements WriterLike {
  private resolved: ResolvedPowerShell | null | undefined;
  private helperVerified = false;

  constructor(private readonly options: PowerShellWriterOptions) {}

  async resolve(): Promise<ResolvedPowerShell> {
    if (this.resolved !== undefined) {
      if (this.resolved === null) {
        throw this.unavailableError();
      }
      return this.resolved;
    }

    const configured = normalizeCommand(this.options.configuredPath ?? '');
    if (configured) {
      const resolved = await this.tryResolve(configured, 'option');
      if (!resolved) {
        throw new JsdsmError(
          'WRITER_UNAVAILABLE',
          `写入组件不可执行：${configured}。显式配置失败不会回退。`,
        );
      }
      this.resolved = resolved;
      return resolved;
    }

    const fromEnvironment = normalizeCommand(
      this.environment().JSDSM_WRITER_PATH ?? '',
    );
    if (fromEnvironment) {
      const resolved = await this.tryResolve(fromEnvironment, 'environment');
      if (!resolved) {
        throw new JsdsmError(
          'WRITER_UNAVAILABLE',
          `写入组件不可执行：${fromEnvironment}。JSDSM_WRITER_PATH 配置失败不会回退。`,
        );
      }
      this.resolved = resolved;
      return resolved;
    }

    for (const candidate of this.candidates()) {
      const resolved = await this.tryResolve(candidate, 'auto');
      if (resolved) {
        this.resolved = resolved;
        return resolved;
      }
    }

    this.resolved = null;
    throw this.unavailableError();
  }

  async open(
    targetDirectory: string,
    fileName: string,
    tempName: string,
    options: OpenOptions = {},
  ): Promise<WriteSession> {
    await this.ensureHelper();
    const writer = await this.resolve();

    if (!isSafeName(fileName) || !isSafeName(tempName)) {
      throw new JsdsmError('WRITE_FAILED', '目标文件名或临时文件名无效');
    }

    const timeoutMs =
      options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const environment: NodeJS.ProcessEnv = {
      ...minimalEnvironment(this.environment()),
      COPY_TARGET_DIR: targetDirectory,
      COPY_FILE_NAME: fileName,
      COPY_TEMP_NAME: tempName,
    };
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(
      writer.command,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.options.helperPath,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: environment,
      },
    );

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      child.kill('SIGKILL');
      throw new JsdsmError('WRITER_UNAVAILABLE', '写入进程管道不可用');
    }

    let stdoutText = '';
    let stderrText = '';
    let exitCode: number | null = null;
    let settled = false;
    let aborted = false;
    let timer: NodeJS.Timeout | null = null;

    let resolveDone!: (result: WriteResult) => void;
    let rejectDone!: (error: Error) => void;
    const completed = new Promise<WriteResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    completed.catch(() => {});

    const finish = (error: Error | null, result?: WriteResult): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        rejectDone(error);
      } else {
        resolveDone(result as WriteResult);
      }
    };

    stdout.on('data', (chunk: Buffer) => {
      stdoutText = appendLimited(stdoutText, chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      stderrText = appendLimited(stderrText, chunk);
    });
    stdin.on('error', () => {
      // 写入失败由 close/error 分支统一处理，这里只避免未处理的 error 事件。
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          new JsdsmError(
            'WRITE_FAILED',
            `写入超时（${Math.round(timeoutMs / 1_000)} 秒）`,
          ),
        );
      }, timeoutMs);
    }

    child.once('error', (error) => {
      finish(
        new JsdsmError(
          'WRITER_UNAVAILABLE',
          `无法启动写入组件：${errorMessage(error)}`,
          error,
        ),
      );
    });

    child.once('close', (code) => {
      exitCode = code;
      if (settled) return;
      if (aborted) {
        finish(new JsdsmError('CANCELLED', '写入已取消'));
        return;
      }
      if (code !== 0) {
        finish(parseWriterError(stderrText, code, stdoutText));
        return;
      }
      const result = parseWriterOutput(stdoutText, targetDirectory, tempName);
      if (!result) {
        finish(
          new JsdsmError(
            'WRITE_FAILED',
            `写入进程返回了无效结果（退出码 ${exitCode ?? '未知'}）`,
          ),
        );
        return;
      }
      finish(null, result);
    });

    return {
      stdin,
      completed,
      abort: () => {
        if (settled) return;
        aborted = true;
        stdin.destroy();
        child.kill('SIGKILL');
        finish(new JsdsmError('CANCELLED', '写入已取消'));
      },
    };
  }

  private async ensureHelper(): Promise<void> {
    if (this.helperVerified) return;
    const stat = await fs.stat(this.options.helperPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new JsdsmError(
        'WRITER_UNAVAILABLE',
        `写入组件文件不存在：${this.options.helperPath}`,
      );
    }
    this.helperVerified = true;
  }

  private async tryResolve(
    command: string,
    source: WriterSource,
  ): Promise<ResolvedPowerShell | null> {
    try {
      const version = await this.queryVersion(command);
      if (!version || !VERSION_PATTERN.test(version)) {
        return null;
      }
      return { command, version, source };
    } catch {
      return null;
    }
  }

  private queryVersion(command: string): Promise<string | null> {
    if (this.options.queryVersion) {
      return this.options.queryVersion(command);
    }
    return defaultQueryVersion(command, this.environment());
  }

  private candidates(): string[] {
    if (this.options.candidates) {
      return this.options.candidates();
    }
    const environment = this.environment();
    const platform = this.options.platform ?? process.platform;
    const delimiter = platform === 'win32' ? ';' : ':';
    const pathDirectories = (environment.PATH ?? '')
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    const result: string[] = [];

    if (platform === 'win32') {
      const systemRoot = environment.SystemRoot;
      if (systemRoot) {
        result.push(
          path.win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
        );
      }
      for (const directory of pathDirectories) {
        result.push(
          path.win32.join(directory, 'powershell.exe'),
          path.win32.join(directory, 'pwsh.exe'),
        );
      }
      result.push('powershell.exe', 'pwsh.exe');
    } else {
      for (const directory of pathDirectories) {
        result.push(path.posix.join(directory, 'pwsh'));
      }
      result.push('/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh', 'pwsh');
    }

    return deduplicate(result, platform === 'win32');
  }

  private environment(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private unavailableError(): JsdsmError {
    return new JsdsmError(
      'WRITER_UNAVAILABLE',
      '未找到可用的写入组件。请确认运行环境，或使用 --writer-path 指定路径。',
    );
  }
}

export function parseWriterOutput(
  raw: string,
  targetDirectory: string,
  tempName: string,
): WriteResult | null {
  const trimmed = raw.trim().replace(/^﻿/, '');
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      bytes?: unknown;
      sha256?: unknown;
    };
    if (!Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 0) {
      return null;
    }
    if (
      typeof parsed.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(parsed.sha256)
    ) {
      return null;
    }
    return {
      bytesWritten: parsed.bytes as number,
      sha256: parsed.sha256.toLowerCase(),
      tempPath: path.join(targetDirectory, tempName),
    };
  } catch {
    return null;
  }
}

export function parseWriterError(
  stderr: string,
  code: number | null,
  stdout = '',
): JsdsmError {
  const fallback = `写入失败${
    code === null ? '' : `（退出码 ${code}）`
  }，未返回错误详情。请检查运行环境和文件权限。`;
  const detail = stderr.trim() || stdout.trim();
  if (!detail) {
    return new JsdsmError('WRITE_FAILED', fallback);
  }
  try {
    const parsed = JSON.parse(detail) as {
      messageBase64?: unknown;
      message?: unknown;
    };
    const message =
      typeof parsed.messageBase64 === 'string'
        ? Buffer.from(parsed.messageBase64, 'base64').toString('utf8')
        : typeof parsed.message === 'string'
          ? parsed.message
          : '';
    return new JsdsmError('WRITE_FAILED', message || fallback);
  } catch {
    return new JsdsmError(
      'WRITE_FAILED',
      `${fallback}：${detail.slice(0, 500)}`,
    );
  }
}

function defaultQueryVersion(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let timer: NodeJS.Timeout | null = null;
    const finish = (version: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(version);
    };

    const child = spawn(
      command,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.ToString()',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
        env: minimalEnvironment(environment),
      },
    );

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, VERSION_QUERY_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 100) {
        output += chunk.toString('utf8');
      }
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      const version = output.trim();
      finish(code === 0 && VERSION_PATTERN.test(version) ? version : null);
    });
  });
}

function minimalEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value) {
      environment[key] = value;
    }
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
  return command;
}

function isSafeName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    path.basename(value) === value
  );
}

function appendLimited(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE_BYTES) {
    return current;
  }
  const next = current + chunk.toString('utf8');
  return next.length > MAX_CAPTURE_BYTES
    ? next.slice(0, MAX_CAPTURE_BYTES)
    : next;
}

function deduplicate(values: string[], caseInsensitive: boolean): string[] {
  if (!caseInsensitive) {
    return [...new Set(values)];
  }
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
