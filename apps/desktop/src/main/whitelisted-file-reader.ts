import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DsmError, type FileContentReadOptions } from '@dsm/core';

import type { ReaderProbeResult } from '../shared.ts';
import type { Logger } from './logger.ts';
import {
  minimalEnvironment,
  NodeExecutableResolver,
  type ResolvedNode,
} from './node-path.ts';

const DEFAULT_READ_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PROBE_BYTES = 100 * 1024 * 1024;

export interface WhitelistedFileReaderOptions {
  helperPath: string;
  getConfiguredNodePath: () => Promise<string | null>;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * 通过外部 Node 进程读取文件，再以 stdout 管道把明文交给主进程。
 *
 * 外部 Node 必须位于 DSM 进程白名单中；Electron 主进程不在白名单，
 * 直接 fs.readFile 只能读到密文。内容不落盘，避免明文被再次加密。
 */
export class WhitelistedFileReader {
  private readonly resolver = new NodeExecutableResolver();
  private helperVerified = false;

  constructor(private readonly options: WhitelistedFileReaderOptions) {}

  async read(
    filePath: string,
    options: FileContentReadOptions,
  ): Promise<Buffer> {
    const configuredPath = await this.options.getConfiguredNodePath();
    const node = await this.resolver.resolve(configuredPath);

    if (!node) {
      await this.log('WARN', '未找到可用的 Node，回退为主进程直接读取', {
        hint: 'DSM 受控环境请在设置中填写白名单 Node 的绝对路径',
      });
      const content = await fs.readFile(filePath);
      if (content.length > options.maxBytes) {
        throw new DsmError('FILE_TOO_LARGE', '文件超过上传大小上限', 'CHECK');
      }
      return content;
    }

    await this.ensureHelper();
    const content = await this.spawnRead(node, filePath, options.maxBytes);
    await this.log('INFO', '已通过外部 Node 读取待上传文件', {
      nodePath: node.command,
      nodeVersion: node.version,
      nodeSource: node.source,
      bytes: content.length,
    });
    return content;
  }

  /**
   * 对比主进程直读与实际读取代理的结果，用于在受控机器上确认
   * 白名单 Node 是否真的返回了解密后的明文。只返回哈希和文件头，
   * 不会把文件内容带到 Renderer。
   */
  async probe(
    filePath: string,
    nodePath: string | null,
  ): Promise<ReaderProbeResult> {
    await this.ensureHelper();

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError('FILE_INVALID', '请选择有效的普通文件', 'CHECK');
    }
    if (stat.size <= 0) {
      throw new DsmError('FILE_INVALID', '不能测试空文件', 'CHECK');
    }
    if (stat.size > MAX_PROBE_BYTES) {
      throw new DsmError('FILE_TOO_LARGE', '测试文件不能超过 100 MiB', 'CHECK');
    }

    const node = await this.resolver.resolve(nodePath);
    if (!node) {
      throw new DsmError(
        'READER_UNAVAILABLE',
        '未找到可用的 Node，请在设置中填写白名单 Node 的绝对路径',
        'CHECK',
      );
    }

    const maxBytes = Math.max(stat.size * 2, 1024 * 1024);
    const [direct, viaNode] = await Promise.all([
      fs.readFile(filePath),
      this.spawnRead(node, filePath, maxBytes),
    ]);
    const directSha256 = sha256(direct);
    const readerSha256 = sha256(viaNode);

    return {
      fileName: path.basename(filePath),
      nodePath: node.command,
      nodeVersion: node.version,
      directSize: direct.length,
      readerSize: viaNode.length,
      directSha256,
      readerSha256,
      directHead: direct.subarray(0, 8).toString('hex'),
      readerHead: viaNode.subarray(0, 8).toString('hex'),
      identical: directSha256 === readerSha256,
    };
  }

  private async ensureHelper(): Promise<void> {
    if (this.helperVerified) return;
    const stat = await fs.stat(this.options.helperPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new DsmError(
        'FILE_READ_FAILED',
        `读取代理脚本不存在：${this.options.helperPath}`,
        'CHECK',
      );
    }
    this.helperVerified = true;
  }

  private spawnRead(
    node: ResolvedNode,
    filePath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        node.command,
        [this.options.helperPath, filePath, String(maxBytes)],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          env: minimalEnvironment(),
        },
      );

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
            `无法启动 Node 读取进程：${error.message}`,
            'CHECK',
            true,
          ),
        );
      });

      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(parseHelperError(stderr, code));
          return;
        }
        if (total === 0) {
          finish(
            new DsmError(
              'FILE_READ_FAILED',
              'Node 读取进程未返回内容',
              'CHECK',
            ),
          );
          return;
        }
        finish(null);
      });
    });
  }

  private async log(
    level: 'INFO' | 'WARN',
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.options.logger) return;
    await this.options.logger
      .log(level, 'FILE', message, { details })
      .catch(() => {});
  }
}

function parseHelperError(stderr: string, code: number | null): DsmError {
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
    message || `Node 读取进程失败${code === null ? '' : `（退出码 ${code}）`}`,
    'CHECK',
  );
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
