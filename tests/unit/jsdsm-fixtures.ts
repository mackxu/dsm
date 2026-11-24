import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type {
  CliIO,
  WriteResult,
  WriteSession,
  WriterLike,
} from 'jsdsm';

export interface FakeWriterOptions {
  /** 让 PowerShell 侧报告的字节数与实际写入不同。 */
  bytesDelta?: number;
  /** 覆盖 PowerShell 侧报告的 SHA-256。 */
  hashOverride?: string;
  /** 让 stdin 写入立即失败。 */
  fail?: Error;
  /** 记录 open() 收到的参数。 */
  onOpen?: (directory: string, fileName: string, tempName: string) => void;
}

/**
 * 在测试中模拟 dsm-file-writer.ps1：消费 stdin，写出 .part 文件，并返回
 * 与真实脚本相同形状的 { bytes, sha256 }。
 */
export function createFakeWriter(options: FakeWriterOptions = {}): WriterLike {
  return {
    async open(directory, fileName, tempName): Promise<WriteSession> {
      options.onOpen?.(directory, fileName, tempName);
      const tempPath = path.join(directory, tempName);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let aborted = false;
      let resolveDone!: (result: WriteResult) => void;
      let rejectDone!: (error: Error) => void;
      const completed = new Promise<WriteResult>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      completed.catch(() => {});

      const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (options.fail) {
            callback(options.fail);
            return;
          }
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          bytes += buffer.length;
          callback();
        },
        final(callback) {
          void (async () => {
            try {
              if (aborted) {
                throw new Error('aborted');
              }
              const content = Buffer.concat(chunks);
              await fs.writeFile(tempPath, content, { flag: 'wx' });
              const sha256 = createHash('sha256')
                .update(content)
                .digest('hex');
              resolveDone({
                bytesWritten: bytes + (options.bytesDelta ?? 0),
                sha256: options.hashOverride ?? sha256,
                tempPath,
              });
              callback();
            } catch (error) {
              const failure =
                error instanceof Error ? error : new Error(String(error));
              rejectDone(failure);
              callback(failure);
            }
          })();
        },
      });

      return {
        stdin,
        completed,
        abort() {
          aborted = true;
          stdin.destroy();
          rejectDone(new Error('aborted'));
        },
      };
    },
  };
}

export interface MemoryIO extends CliIO {
  readonly stdoutText: string;
  readonly stderrText: string;
}

export function createMemoryIO(): MemoryIO {
  let stdoutText = '';
  let stderrText = '';
  return {
    get stdoutText() {
      return stdoutText;
    },
    get stderrText() {
      return stderrText;
    },
    stdout(text): void {
      stdoutText += text;
    },
    stderr(text): void {
      stderrText += text;
    },
  };
}

const temporaryDirectories: string[] = [];

export async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsdsm-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
}

export async function writeSourceFile(
  directory: string,
  name: string,
  content: string | Buffer,
): Promise<string> {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

export async function listDirectory(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}
