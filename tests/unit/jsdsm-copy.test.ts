import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { copyViaPowerShell, type CopyProgress } from 'jsdsm';

import {
  cleanupTemporaryDirectories,
  createFakeWriter,
  listDirectory,
  makeTemporaryDirectory,
  writeSourceFile,
} from './jsdsm-fixtures.ts';

afterEach(cleanupTemporaryDirectories);

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code });
  return error as Error;
}

describe('copyViaPowerShell', () => {
  it('流式写入指定目录并校验内容', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    const result = await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
    });

    expect(result).toMatchObject({
      sourcePath: source,
      targetPath: path.join(output, 'a.txt'),
      bytes: 5,
      renamed: false,
    });
    expect(await fs.readFile(result.targetPath, 'utf8')).toBe('hello');
    expect(await listDirectory(output)).toEqual(['a.txt']);
  });

  it('报告读取、写入与校验阶段', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');
    const events: CopyProgress[] = [];

    await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
      onProgress: (event) => events.push(event),
    });

    const phases = events.map((event) => event.phase);
    expect(phases).toContain('reading');
    expect(phases).toContain('writing');
    expect(phases).toContain('verifying');
    expect(phases.indexOf('reading')).toBeLessThan(
      phases.indexOf('writing'),
    );
    expect(phases.indexOf('writing')).toBeLessThan(
      phases.indexOf('verifying'),
    );
  });

  it('大文件按阈值报告已处理字节数', async () => {
    const root = await makeTemporaryDirectory();
    const content = Buffer.alloc(11 * 1024 * 1024, 7);
    const source = await writeSourceFile(root, 'large.bin', content);
    const output = path.join(root, 'out');
    const events: CopyProgress[] = [];

    await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
      onProgress: (event) => events.push(event),
    });

    const progressEvents = events.filter(
      (event): event is Extract<CopyProgress, { phase: 'progress' }> =>
        event.phase === 'progress',
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.at(-1)?.bytes).toBe(content.length);
  });

  it('默认写回源目录时自动改名，绝不覆盖源文件', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');

    const result = await copyViaPowerShell(source, root, {
      writer: createFakeWriter(),
    });

    expect(path.basename(result.targetPath)).toBe('a (1).txt');
    expect(result.renamed).toBe(true);
    expect(await fs.readFile(source, 'utf8')).toBe('hello');
    expect(await listDirectory(root)).toEqual(['a (1).txt', 'a.txt']);
  });

  it('连续冲突时递增后缀且不改动已有文件', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'new');
    const output = path.join(root, 'out');
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'a.txt'), 'old-0');
    await fs.writeFile(path.join(output, 'a (1).txt'), 'old-1');

    const result = await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
    });

    expect(path.basename(result.targetPath)).toBe('a (2).txt');
    expect(await fs.readFile(path.join(output, 'a.txt'), 'utf8')).toBe(
      'old-0',
    );
    expect(
      await fs.readFile(path.join(output, 'a (1).txt'), 'utf8'),
    ).toBe('old-1');
    expect(await fs.readFile(result.targetPath, 'utf8')).toBe('new');
  });

  it('递归创建不存在的输出目录', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'deep', 'nested', 'out');

    const result = await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
    });

    expect(result.targetPath).toBe(path.join(output, 'a.txt'));
    expect(await fs.readFile(result.targetPath, 'utf8')).toBe('hello');
  });

  it('支持空文件', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'empty.txt', '');
    const output = path.join(root, 'out');

    const result = await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
    });

    expect(result.bytes).toBe(0);
    expect(await fs.stat(result.targetPath)).toMatchObject({ size: 0 });
  });

  it('支持中文与空格文件名', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, '报告 2026.txt', '内容');
    const output = path.join(root, '导出 目录');

    const result = await copyViaPowerShell(source, output, {
      writer: createFakeWriter(),
    });

    expect(result.targetPath).toBe(path.join(output, '报告 2026.txt'));
    expect(await fs.readFile(result.targetPath, 'utf8')).toBe('内容');
  });

  it('源文件不存在时报 SOURCE_NOT_FOUND', async () => {
    const root = await makeTemporaryDirectory();
    await expectCode(
      copyViaPowerShell(path.join(root, 'missing.txt'), root, {
        writer: createFakeWriter(),
      }),
      'SOURCE_NOT_FOUND',
    );
  });

  it('源路径是目录时报 SOURCE_NOT_FILE', async () => {
    const root = await makeTemporaryDirectory();
    await expectCode(
      copyViaPowerShell(root, root, { writer: createFakeWriter() }),
      'SOURCE_NOT_FILE',
    );
  });

  it('输出路径是普通文件时报 OUTPUT_DIRECTORY_INVALID', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const blocker = path.join(root, 'blocker');
    await fs.writeFile(blocker, 'x');

    await expectCode(
      copyViaPowerShell(source, blocker, {
        writer: createFakeWriter(),
      }),
      'OUTPUT_DIRECTORY_INVALID',
    );
  });

  it('写入组件报告字节数不一致时报 WRITE_VERIFY_FAILED 并清理', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter({ bytesDelta: 1 }),
      }),
      'WRITE_VERIFY_FAILED',
    );

    expect(await listDirectory(output)).toEqual([]);
  });

  it('写入组件报告哈希不一致时报 WRITE_VERIFY_FAILED 并清理', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter({ hashOverride: '0'.repeat(64) }),
      }),
      'WRITE_VERIFY_FAILED',
    );

    expect(await listDirectory(output)).toEqual([]);
  });

  it('写入失败时清理临时文件', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    const error = await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter({ fail: new Error('disk full') }),
      }),
      'WRITE_FAILED',
    );
    expect(error.message).toContain('disk full');
    expect(await listDirectory(output)).toEqual([]);
  });

  it('读取流失败时映射为 SOURCE_UNREADABLE 并清理', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter(),
        deps: {
          createReadStream: () =>
            new Readable({
              read() {
                const error = new Error(
                  'read boom',
                ) as NodeJS.ErrnoException;
                error.code = 'EIO';
                this.destroy(error);
              },
            }),
        },
      }),
      'SOURCE_UNREADABLE',
    );

    expect(await listDirectory(output)).toEqual([]);
  });

  it('预中止的 signal 不会创建输出目录', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');
    const controller = new AbortController();
    controller.abort();

    await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter(),
        signal: controller.signal,
      }),
      'CANCELLED',
    );

    expect(await fs.stat(output).catch(() => null)).toBeNull();
  });

  it('rename 失败时清理占位文件与临时文件', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');

    await expectCode(
      copyViaPowerShell(source, output, {
        writer: createFakeWriter(),
        deps: {
          rename: async () => {
            const error = new Error(
              'rename failed',
            ) as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          },
        },
      }),
      'PUBLISH_FAILED',
    );

    expect(await listDirectory(output)).toEqual([]);
  });
});
