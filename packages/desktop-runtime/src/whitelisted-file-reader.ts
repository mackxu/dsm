import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';

import {
  DsmError,
  type FileContentReadOptions,
  type FileReadStream,
  type ReaderKind,
  type ReaderProbeResult,
  type ReaderSelection,
} from '@dsm/core';

import type { LogLevel, Logger } from './logger.ts';
import { NodeExecutableResolver } from './node-path.ts';
import { PythonExecutableResolver } from './python-path.ts';
import {
  minimalEnvironment,
  type ReaderResolver,
  type ResolvedReader,
} from './reader-executable.ts';
import {
  readerLabel,
  resolveReaderChain,
  type ReaderChainResult,
} from './reader-chain.ts';

const DEFAULT_READ_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PROBE_BYTES = 100 * 1024 * 1024;

export interface WhitelistedFileReaderOptions {
  nodeHelperPath: string;
  pythonHelperPath: string;
  getReaderSelection: () => Promise<ReaderSelection>;
  logger?: Logger;
  timeoutMs?: number;
  /** 仅测试注入；生产不传。 */
  resolvers?: Partial<Record<ReaderKind, ReaderResolver>>;
}

export interface ReaderHelperPaths {
  node: string;
  python: string;
}

export function buildHelperInvocation(
  reader: ResolvedReader,
  helpers: ReaderHelperPaths,
  filePath: string,
  maxBytes: number,
): { command: string; args: string[] } {
  if (reader.kind === 'python') {
    return {
      command: reader.command,
      args: [
        '-I',
        '-S',
        '-B',
        '-u',
        helpers.python,
        filePath,
        String(maxBytes),
      ],
    };
  }

  return {
    command: reader.command,
    args: [helpers.node, filePath, String(maxBytes)],
  };
}

/**
 * 通过外部白名单进程读取文件，再以 stdout 管道把明文交给主进程。
 *
 * 优先使用用户选择的读取器（Node 或 Python）；只有优先读取器没有显式
 * 配置且自动探测完全失败时，才尝试另一个读取器。显式配置不可执行、
 * helper 缺失、spawn 失败、超时和退出码错误都不会触发回退。
 */
export class WhitelistedFileReader {
  private readonly resolvers: Record<ReaderKind, ReaderResolver>;
  private readonly verifiedHelpers = new Set<ReaderKind>();

  constructor(private readonly options: WhitelistedFileReaderOptions) {
    this.resolvers = {
      node: options.resolvers?.node ?? new NodeExecutableResolver(),
      python: options.resolvers?.python ?? new PythonExecutableResolver(),
    };
  }

  async read(
    filePath: string,
    options: FileContentReadOptions,
  ): Promise<Buffer> {
    const selection = await this.options.getReaderSelection();
    const { reader, fallbackUsed } = await resolveReaderChain(
      selection,
      this.resolvers,
    );

    if (fallbackUsed) {
      await this.log(
        'INFO',
        `默认读取方式 ${readerLabel(selection.preferredReader)} 不可用，已改用 ${readerLabel(reader.kind)}`,
        {
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          readerSource: reader.source,
          preferredReader: selection.preferredReader,
        },
      );
    }

    await this.ensureHelper(reader.kind);
    // 先记录实际尝试的解释器，spawn 失败时日志里也能看到路径。
    await this.log(
      'INFO',
      `开始通过外部 ${readerLabel(reader.kind)} 读取待上传文件`,
      {
        readerKind: reader.kind,
        readerPath: reader.command,
        readerVersion: reader.version,
        readerSource: reader.source,
        preferredReader: selection.preferredReader,
        fallbackUsed,
      },
    );
    let content: Buffer;
    try {
      content = await this.spawnRead(reader, filePath, options.maxBytes);
    } catch (error) {
      await this.log(
        'ERROR',
        `通过外部 ${readerLabel(reader.kind)} 读取文件失败：${errorMessage(error)}`,
        {
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          readerSource: reader.source,
          preferredReader: selection.preferredReader,
          fallbackUsed,
          ...(error instanceof DsmError
            ? {
                code: error.code,
                stage: error.stage,
                recoverable: error.recoverable,
              }
            : {}),
        },
      );
      throw error;
    }
    await this.log(
      'INFO',
      `已通过外部 ${readerLabel(reader.kind)} 读取待上传文件`,
      {
        readerKind: reader.kind,
        readerPath: reader.command,
        readerVersion: reader.version,
        readerSource: reader.source,
        preferredReader: selection.preferredReader,
        fallbackUsed,
        bytes: content.length,
      },
    );
    return content;
  }

  /**
   * 流式读取：helper stdout 经限流 Transform 交给管道消费端。
   *
   * 读取语义、显式配置不回退规则与 read() 完全一致；调用方必须消费
   * 返回的 stream，并在失败时调用 abort() 结束 helper 进程。
   */
  async openStream(
    filePath: string,
    options: { maxBytes: number; timeoutMs?: number },
  ): Promise<FileReadStream> {
    const selection = await this.options.getReaderSelection();
    const { reader, fallbackUsed } = await resolveReaderChain(
      selection,
      this.resolvers,
    );

    if (fallbackUsed) {
      await this.log(
        'INFO',
        `默认读取方式 ${readerLabel(selection.preferredReader)} 不可用，已改用 ${readerLabel(reader.kind)}`,
        {
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          readerSource: reader.source,
          preferredReader: selection.preferredReader,
        },
      );
    }

    await this.ensureHelper(reader.kind);
    await this.log(
      'INFO',
      `开始通过外部 ${readerLabel(reader.kind)} 流式读取文件`,
      {
        readerKind: reader.kind,
        readerPath: reader.command,
        readerVersion: reader.version,
        readerSource: reader.source,
        preferredReader: selection.preferredReader,
        fallbackUsed,
      },
    );
    return this.spawnStream(
      reader,
      filePath,
      options.maxBytes,
      options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    );
  }

  /**
   * 启动/复检时探测整条读取器链，只验证解释器可执行，不读取文件。
   *
   * 探测前清空自动探测缓存；失败后再清空一次，避免把“本次不可用”
   * 缓存成后续 read() 的永久结果。用户安装解释器后，无需重启应用
   * 即可在重新检测或下一次任务中重新探测成功。
   */
  async checkAvailability(): Promise<ReaderChainResult> {
    this.resetAutoDetection();
    try {
      const selection = await this.options.getReaderSelection();
      return await resolveReaderChain(selection, this.resolvers);
    } catch (error) {
      this.resetAutoDetection();
      throw error;
    }
  }

  /**
   * 对比主进程直读与实际读取代理的结果，用于在受控机器上确认
   * 白名单解释器是否真的返回了解密后的明文。只返回哈希和文件头，
   * 不会把文件内容带到 Renderer。
   */
  async probe(
    filePath: string,
    selection: ReaderSelection,
  ): Promise<ReaderProbeResult> {
    this.resetAutoDetection();

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError('FILE_INVALID', '请选择有效的普通文件', 'CHECK');
    }
    if (stat.size <= 0) {
      throw new DsmError('FILE_INVALID', '不能测试空文件', 'CHECK');
    }
    if (stat.size > MAX_PROBE_BYTES) {
      throw new DsmError('FILE_TOO_LARGE', '测试文件不能超过 100 MB', 'CHECK');
    }

    const { reader, fallbackUsed } = await resolveReaderChain(
      selection,
      this.resolvers,
    );
    await this.ensureHelper(reader.kind);

    const maxBytes = Math.max(stat.size * 2, 1024 * 1024);
    const [direct, viaReader] = await Promise.all([
      fs.readFile(filePath),
      this.spawnRead(reader, filePath, maxBytes),
    ]);
    const directSha256 = sha256(direct);
    const readerSha256 = sha256(viaReader);

    return {
      fileName: path.basename(filePath),
      preferredReader: selection.preferredReader,
      usedReader: reader.kind,
      fallbackUsed,
      readerPath: reader.command,
      readerVersion: reader.version,
      readerSource: reader.source,
      directSize: direct.length,
      readerSize: viaReader.length,
      directSha256,
      readerSha256,
      directHead: direct.subarray(0, 8).toString('hex'),
      readerHead: viaReader.subarray(0, 8).toString('hex'),
      identical: directSha256 === readerSha256,
    };
  }

  reset(): void {
    this.verifiedHelpers.clear();
    this.resetAutoDetection();
  }

  private resetAutoDetection(): void {
    this.resolvers.node.resetAutoDetection();
    this.resolvers.python.resetAutoDetection();
  }

  private helperPathFor(kind: ReaderKind): string {
    return kind === 'node'
      ? this.options.nodeHelperPath
      : this.options.pythonHelperPath;
  }

  private async ensureHelper(kind: ReaderKind): Promise<void> {
    if (this.verifiedHelpers.has(kind)) return;
    const helperPath = this.helperPathFor(kind);
    const stat = await fs.stat(helperPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError(
        'FILE_READ_FAILED',
        `读取代理脚本不存在：${helperPath}`,
        'CHECK',
      );
    }
    this.verifiedHelpers.add(kind);
  }

  private spawnRead(
    reader: ResolvedReader,
    filePath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const label = readerLabel(reader.kind);
      const invocation = buildHelperInvocation(
        reader,
        {
          node: this.options.nodeHelperPath,
          python: this.options.pythonHelperPath,
        },
        filePath,
        maxBytes,
      );
      const child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: minimalEnvironment(),
      });

      const chunks: Buffer[] = [];
      let total = 0;
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.concat(chunks, total));
      };

      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new DsmError('FILE_READ_FAILED', '读取文件超时', 'CHECK', true));
      }, this.options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          child.kill('SIGKILL');
          finish(
            new DsmError('FILE_TOO_LARGE', '文件超过上传大小上限', 'CHECK'),
          );
          return;
        }
        chunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length >= MAX_STDERR_BYTES) return;
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_STDERR_BYTES) {
          stderr = stderr.slice(0, MAX_STDERR_BYTES);
        }
      });

      child.once('error', (error) => {
        finish(
          new DsmError(
            'FILE_READ_FAILED',
            `无法启动 ${label} 读取进程：${error.message}`,
            'CHECK',
            true,
          ),
        );
      });

      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(parseHelperError(stderr, code, label));
          return;
        }
        if (total === 0) {
          finish(
            new DsmError(
              'FILE_READ_FAILED',
              `${label} 读取进程未返回内容`,
              'CHECK',
            ),
          );
          return;
        }
        finish(null);
      });
    });
  }

  private spawnStream(
    reader: ResolvedReader,
    filePath: string,
    maxBytes: number,
    timeoutMs: number,
  ): FileReadStream {
    const label = readerLabel(reader.kind);
    const startedAt = Date.now();
    const invocation = buildHelperInvocation(
      reader,
      {
        node: this.options.nodeHelperPath,
        python: this.options.pythonHelperPath,
      },
      filePath,
      maxBytes,
    );
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: minimalEnvironment(),
    });

    let total = 0;
    let stderr = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let aborted = false;
    let timer: NodeJS.Timeout | null = null;

    let resolveDone!: (bytes: number) => void;
    let rejectDone!: (error: Error) => void;
    const completed = new Promise<number>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // 调用方可能只消费 stream 而未 await completed；内部兜底避免
    // 未处理的 rejection 影响进程。
    completed.catch(() => {});

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        void this.log('ERROR', `外部 ${label} 流式读取失败：${error.message}`, {
          ...(error instanceof DsmError
            ? {
                code: error.code,
                stage: error.stage,
                recoverable: error.recoverable,
              }
            : {}),
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          readerSource: reader.source,
          filePath,
          bytes: total,
          exitCode,
          signal: exitSignal,
          stderr: truncateOutput(stderr),
          elapsedMs: Date.now() - startedAt,
        });
        rejectDone(error);
      } else {
        void this.log('INFO', `外部 ${label} 流式读取完成`, {
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          bytes: total,
          exitCode,
          elapsedMs: Date.now() - startedAt,
          ...(stderr.trim() ? { stderr: truncateOutput(stderr) } : {}),
        });
        resolveDone(total);
      }
    };

    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (settled) {
          callback();
          return;
        }
        total += chunk.length;
        if (total > maxBytes) {
          callback(
            new DsmError('FILE_TOO_LARGE', '文件超过复制大小上限', 'CHECK'),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    // 消费端可能尚未 attach error 监听，这里先兜底并同步结束 completed。
    limiter.on('error', (error: Error) => {
      child.kill('SIGKILL');
      finish(
        error instanceof DsmError
          ? error
          : new DsmError('FILE_READ_FAILED', error.message, 'CHECK', true),
      );
    });

    child.stdout.on('error', (error: Error) => {
      limiter.destroy(error);
    });
    child.stdout.pipe(limiter);

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DsmError('FILE_READ_FAILED', '读取文件超时', 'CHECK', true));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.slice(0, MAX_STDERR_BYTES);
      }
    });

    child.once('error', (error) => {
      finish(
        new DsmError(
          'FILE_READ_FAILED',
          `无法启动 ${label} 读取进程：${error.message}`,
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
        finish(new DsmError('FILE_READ_FAILED', '读取已取消', 'CHECK', true));
        return;
      }
      if (code !== 0) {
        finish(parseHelperError(stderr, code, label));
        return;
      }
      if (total === 0) {
        finish(
          new DsmError(
            'FILE_READ_FAILED',
            `${label} 读取进程未返回内容`,
            'CHECK',
          ),
        );
        return;
      }
      finish(null);
    });

    return {
      stream: limiter,
      completed,
      abort: () => {
        if (settled) return;
        aborted = true;
        child.kill('SIGKILL');
        limiter.destroy();
        finish(new DsmError('FILE_READ_FAILED', '读取已取消', 'CHECK', true));
      },
    };
  }

  private async log(
    level: LogLevel,
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.options.logger) return;
    await this.options.logger
      .log(level, 'FILE', message, { details })
      .catch(() => {});
  }
}

function parseHelperError(
  stderr: string,
  code: number | null,
  label: string,
): DsmError {
  let helperCode = '';
  let message = '';
  try {
    const parsed = JSON.parse(stderr.trim()) as {
      code?: unknown;
      message?: unknown;
    };
    if (typeof parsed.code === 'string') helperCode = parsed.code;
    if (typeof parsed.message === 'string') {
      message = parsed.message.slice(0, 500);
    }
  } catch {
    // The helper may have failed before it could write structured output.
  }

  if (helperCode === 'FILE_TOO_LARGE') {
    return new DsmError(
      'FILE_TOO_LARGE',
      message || '文件超过上传大小上限',
      'CHECK',
    );
  }
  if (helperCode === 'FILE_READ_FAILED') {
    return new DsmError(
      'FILE_READ_FAILED',
      message || '读取文件失败',
      'CHECK',
      true,
    );
  }
  return new DsmError(
    'FILE_READ_FAILED',
    message ||
      `${label} 读取进程失败${code === null ? '' : `（退出码 ${code}）`}`,
    'CHECK',
  );
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}…` : trimmed;
}
