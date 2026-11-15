import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DsmError,
  type FileStreamWriteOptions,
  type FileWriteResult,
  type FileWriteSession,
  type ReaderSource,
} from '@dsm/core';

import type { LogLevel, Logger } from './logger.ts';
import {
  minimalEnvironment,
  normalizeCommand,
  queryExecutableVersion,
} from './reader-executable.ts';

const DEFAULT_WRITE_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TEST_WRITE_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+){0,2}$/;

export type WriterSource = ReaderSource;

export interface ResolvedWriter {
  command: string;
  version: string;
  source: WriterSource;
}

export interface WriterCheckResult {
  writerPath: string;
  writerVersion: string;
  writerSource: WriterSource;
}

export interface PowerShellWriterOptions {
  helperPath: string;
  getConfiguredPath: () => Promise<string | null>;
  logger?: Logger;
  timeoutMs?: number;
  /** 仅测试注入。 */
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  queryVersion?: (command: string) => Promise<string | null>;
}

/**
 * 通过白名单 PowerShell 写入明文。
 *
 * 优先级：配置路径 → `POWERSHELL_PATH` 环境变量 → 自动探测。显式配置
 * 不可执行时抛 `WRITER_UNAVAILABLE`，不做静默回退；自动探测失败时返回
 * null，由调用方给出安装/配置提示。
 *
 * 写入代理只写目标目录下的 `.part` 临时文件并返回字节数与 SHA-256；
 * 最终 rename 与失败清理由 CopyController 负责。
 */
export class PowerShellWriter {
  private readonly cache = new Map<string, ResolvedWriter>();
  private autoResolved: ResolvedWriter | null | undefined;
  private helperVerified = false;

  constructor(private readonly options: PowerShellWriterOptions) {}

  async checkAvailability(): Promise<WriterCheckResult> {
    this.autoResolved = undefined;
    try {
      await this.ensureHelper();
      const writer = await this.resolveOrThrow();
      await this.log('INFO', `PowerShell 写入器检查通过：${writer.version}`, {
        writerPath: writer.command,
        writerVersion: writer.version,
        writerSource: writer.source,
      });
      return {
        writerPath: writer.command,
        writerVersion: writer.version,
        writerSource: writer.source,
      };
    } catch (error) {
      this.autoResolved = undefined;
      await this.log(
        'ERROR',
        `PowerShell 写入器检查失败：${errorMessage(error)}`,
        {
          helperPath: this.options.helperPath,
          ...(error instanceof DsmError
            ? { code: error.code, stage: error.stage }
            : {}),
        },
      );
      throw error;
    }
  }

  reset(): void {
    this.cache.clear();
    this.autoResolved = undefined;
    this.helperVerified = false;
  }

  async open(
    targetDirectory: string,
    fileName: string,
    tempName: string,
    options: FileStreamWriteOptions & { configuredPath?: string | null },
  ): Promise<FileWriteSession> {
    let writer: ResolvedWriter;
    try {
      await this.ensureHelper();
      writer = await this.resolveOrThrow(options.configuredPath);
    } catch (error) {
      await this.log(
        'ERROR',
        `PowerShell 写入器不可用：${errorMessage(error)}`,
        {
          helperPath: this.options.helperPath,
          configuredPath: options.configuredPath ?? null,
          ...(error instanceof DsmError
            ? { code: error.code, stage: error.stage }
            : {}),
        },
      );
      throw error;
    }
    const startedAt = Date.now();
    const timeoutMs =
      options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    const environment = {
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
      throw new DsmError(
        'WRITER_UNAVAILABLE',
        'PowerShell 写入进程管道不可用',
        'CHECK',
      );
    }

    let stdoutText = '';
    let stderrText = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let aborted = false;
    let timer: NodeJS.Timeout | null = null;

    let resolveDone!: (result: FileWriteResult) => void;
    let rejectDone!: (error: Error) => void;
    const completed = new Promise<FileWriteResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    completed.catch(() => {});
    stdin.on('error', (error: NodeJS.ErrnoException) => {
      void this.log('WARN', 'PowerShell stdin 写入失败', {
        message: error.message,
        code: error.code,
        elapsedMs: Date.now() - startedAt,
      });
    });

    const finish = (error: Error | null, result?: FileWriteResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        void this.log('ERROR', `PowerShell 写入失败：${error.message}`, {
          ...(error instanceof DsmError
            ? {
                code: error.code,
                stage: error.stage,
                recoverable: error.recoverable,
              }
            : {}),
          command: writer.command,
          helperPath: this.options.helperPath,
          targetDirectory,
          fileName,
          tempName,
          exitCode,
          signal: exitSignal,
          elapsedMs: Date.now() - startedAt,
          stdout: truncateOutput(stdoutText),
          stderr: truncateOutput(stderrText),
        });
        rejectDone(error);
      } else {
        const written = result as FileWriteResult;
        void this.log('INFO', 'PowerShell 写入完成', {
          command: writer.command,
          bytesWritten: written.bytesWritten,
          sha256: written.sha256,
          tempPath: written.tempPath,
          elapsedMs: Date.now() - startedAt,
        });
        resolveDone(written);
      }
    };

    stdout.on('data', (chunk: Buffer) => {
      if (stdoutText.length >= MAX_OUTPUT_BYTES) return;
      stdoutText += chunk.toString('utf8');
      if (stdoutText.length > MAX_OUTPUT_BYTES) {
        stdoutText = stdoutText.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length >= MAX_OUTPUT_BYTES) return;
      stderrText += chunk.toString('utf8');
      if (stderrText.length > MAX_OUTPUT_BYTES) {
        stderrText = stderrText.slice(0, MAX_OUTPUT_BYTES);
      }
    });

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DsmError('WRITE_FAILED', 'PowerShell 写入超时', 'COPY', true));
    }, timeoutMs);

    child.once('error', (error) => {
      finish(
        new DsmError(
          'WRITER_UNAVAILABLE',
          `无法启动 PowerShell：${error.message}`,
          'CHECK',
          true,
        ),
      );
    });

    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (settled) return;
      if (aborted) {
        finish(
          new DsmError('WRITE_FAILED', 'PowerShell 写入已取消', 'COPY', true),
        );
        return;
      }
      if (code !== 0) {
        finish(parseWriterError(stderrText, code, stdoutText));
        return;
      }
      const result = parseWriterOutput(stdoutText, targetDirectory, tempName);
      if (!result) {
        finish(
          new DsmError(
            'WRITE_FAILED',
            `PowerShell 写入进程返回了无效结果（退出码 ${code}）`,
            'COPY',
            true,
          ),
        );
        return;
      }
      finish(null, result);
    });

    await this.log('INFO', `开始通过 PowerShell 写入文件：${writer.version}`, {
      writerPath: writer.command,
      writerVersion: writer.version,
      writerSource: writer.source,
      helperPath: this.options.helperPath,
      targetDirectory,
      fileName,
      tempName,
      timeoutMs,
    });

    return {
      stdin,
      completed,
      abort: () => {
        if (settled) return;
        aborted = true;
        stdin.destroy();
        child.kill('SIGKILL');
        finish(
          new DsmError('WRITE_FAILED', 'PowerShell 写入已取消', 'COPY', true),
        );
      },
    };
  }

  /**
   * 设置页使用的写入自检：写入 1 MiB 随机数据，校验字节数与 SHA-256，
   * 然后删除临时文件。不会保留任何明文。
   */
  async testWrite(
    directory: string,
    configuredPath?: string | null,
  ): Promise<{ bytes: number; sha256: string }> {
    await fs.mkdir(directory, { recursive: true });
    const base = `.dsm-copy-test-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const fileName = `${base}.bin`;
    const tempName = `${base}.part`;
    const tempPath = path.join(directory, tempName);
    const content = randomBytes(TEST_WRITE_BYTES);
    const expected = createHash('sha256').update(content).digest('hex');

    const session = await this.open(directory, fileName, tempName, {
      timeoutMs: 60_000,
      configuredPath,
    });
    try {
      session.stdin.end(content);
      const result = await session.completed;
      const stat = await fs.stat(result.tempPath).catch(() => null);
      if (
        result.bytesWritten !== content.length ||
        result.sha256 !== expected ||
        stat?.size !== content.length
      ) {
        throw new DsmError(
          'WRITE_VERIFY_FAILED',
          'PowerShell 测试写入校验失败',
          'VERIFY',
        );
      }
      return { bytes: result.bytesWritten, sha256: result.sha256 };
    } finally {
      session.abort();
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async resolve(
    configuredOverride?: string | null,
  ): Promise<ResolvedWriter | null> {
    const configuredValue =
      configuredOverride === undefined
        ? await this.options.getConfiguredPath()
        : configuredOverride;
    const configured = normalizeCommand(configuredValue ?? '');
    if (configured) {
      return this.requireExecutable(configured, 'config');
    }

    const fromEnvironment = normalizeCommand(
      this.environment().POWERSHELL_PATH ?? '',
    );
    if (fromEnvironment) {
      return this.requireExecutable(fromEnvironment, 'environment');
    }

    if (this.autoResolved !== undefined) {
      return this.autoResolved;
    }
    for (const candidate of this.candidates()) {
      const resolved = await this.tryExecutable(candidate, 'auto');
      if (resolved) {
        this.autoResolved = resolved;
        return resolved;
      }
    }
    this.autoResolved = null;
    return null;
  }

  private async resolveOrThrow(
    configuredOverride?: string | null,
  ): Promise<ResolvedWriter> {
    const writer = await this.resolve(configuredOverride);
    if (!writer) {
      throw new DsmError(
        'WRITER_UNAVAILABLE',
        '未找到可用的 PowerShell。请安装 PowerShell，或在设置中指定 powershell.exe 路径。',
        'CHECK',
      );
    }
    return writer;
  }

  private async requireExecutable(
    command: string,
    source: WriterSource,
  ): Promise<ResolvedWriter> {
    const resolved = await this.tryExecutable(command, source);
    if (!resolved) {
      throw new DsmError(
        'WRITER_UNAVAILABLE',
        `PowerShell 不可执行：${command}。显式配置失败不会回退。`,
        'CHECK',
      );
    }
    return resolved;
  }

  private async tryExecutable(
    command: string,
    source: WriterSource,
  ): Promise<ResolvedWriter | null> {
    const cached = this.cache.get(command);
    if (cached) {
      return { ...cached, source };
    }

    const query = this.options.queryVersion ?? defaultQueryVersion;
    const version = await query(command);
    if (!version) {
      return null;
    }

    const resolved: ResolvedWriter = { command, version, source };
    this.cache.set(command, resolved);
    return resolved;
  }

  private candidates(): string[] {
    const environment = this.environment();
    const platform = this.options.platform ?? process.platform;
    const result: string[] = [];
    const pathDirectories = (environment.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean);

    if (platform === 'win32') {
      const systemRoot = environment.SystemRoot;
      if (systemRoot) {
        result.push(
          path.join(
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
          path.join(directory, 'powershell.exe'),
          path.join(directory, 'pwsh.exe'),
        );
      }
      result.push('powershell.exe', 'pwsh.exe');
    } else {
      for (const directory of pathDirectories) {
        result.push(path.join(directory, 'pwsh'));
      }
      result.push('/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh', 'pwsh');
    }

    return [...new Set(result)];
  }

  private environment(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private async ensureHelper(): Promise<void> {
    if (this.helperVerified) return;
    const stat = await fs.stat(this.options.helperPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError(
        'WRITER_UNAVAILABLE',
        `写入代理脚本不存在：${this.options.helperPath}`,
        'CHECK',
      );
    }
    this.helperVerified = true;
  }

  private async log(
    level: LogLevel,
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.options.logger) return;
    await this.options.logger
      .log(level, 'WRITE', message, { details })
      .catch(() => {});
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}…` : trimmed;
}

function defaultQueryVersion(command: string): Promise<string | null> {
  return queryExecutableVersion(
    command,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ],
    VERSION_PATTERN,
  );
}

function parseWriterOutput(
  raw: string,
  targetDirectory: string,
  tempName: string,
): FileWriteResult | null {
  const trimmed = raw.trim().replace(/^﻿/, '');
  if (!trimmed) return null;
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

function parseWriterError(
  stderr: string,
  code: number | null,
  stdout = '',
): DsmError {
  const fallback = `PowerShell 写入失败${
    code === null ? '' : `（退出码 ${code}）`
  }，未返回错误详情。请检查脚本编码、执行策略和 DSM 白名单。`;
  const detail = stderr.trim() || stdout.trim();
  if (!detail) {
    return new DsmError('WRITE_FAILED', fallback, 'COPY', true);
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
    return new DsmError('WRITE_FAILED', message || fallback, 'COPY', true);
  } catch {
    return new DsmError(
      'WRITE_FAILED',
      `${fallback}：${detail.slice(0, 500)}`,
      'COPY',
      true,
    );
  }
}
