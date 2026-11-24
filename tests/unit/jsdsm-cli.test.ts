import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from 'jsdsm';

import {
  cleanupTemporaryDirectories,
  createFakeWriter,
  createMemoryIO,
  makeTemporaryDirectory,
  writeSourceFile,
} from './jsdsm-fixtures.ts';

afterEach(cleanupTemporaryDirectories);

describe('jsdsm runCli', () => {
  it('--help 输出用法并返回 0', async () => {
    const io = createMemoryIO();
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(io.stdoutText).toContain('用法: jsdsm');
    expect(io.stderrText).toBe('');
  });

  it('--version 输出版本并返回 0', async () => {
    const io = createMemoryIO();
    const code = await runCli(['--version'], io, { version: '9.9.9' });
    expect(code).toBe(0);
    expect(io.stdoutText).toBe('9.9.9\n');
  });

  it('未知选项返回用法错误退出码 2', async () => {
    const io = createMemoryIO();
    const code = await runCli(['--bogus'], io);
    expect(code).toBe(2);
    expect(io.stderrText).toContain('用法错误');
  });

  it('缺少源文件返回退出码 2', async () => {
    const io = createMemoryIO();
    const code = await runCli([], io);
    expect(code).toBe(2);
    expect(io.stderrText).toContain('缺少源文件路径');
  });

  it('运行期错误返回退出码 1', async () => {
    const root = await makeTemporaryDirectory();
    const io = createMemoryIO();
    const code = await runCli(
      [path.join(root, 'missing.txt')],
      io,
      { writer: createFakeWriter() },
    );
    expect(code).toBe(1);
    expect(io.stderrText).toContain('源文件不存在');
  });

  it('显式输出目录成功时输出读取、写入与校验进度', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const output = path.join(root, 'out');
    const io = createMemoryIO();

    const code = await runCli([source, output], io, {
      writer: createFakeWriter(),
    });

    expect(code).toBe(0);
    expect(io.stdoutText).toBe(
      `已写入：${path.join(output, 'a.txt')}（5 字节）\n`,
    );
    expect(io.stderrText).toContain(`正在读取：${source}`);
    expect(io.stderrText).toContain(
      `正在写入：${output}`,
    );
    expect(io.stderrText).toContain('正在校验写入结果');
    expect(io.stderrText).not.toContain('如该目录受 DSM 管控');
  });

  it('默认输出目录成功时不输出风险提示', async () => {
    const root = await makeTemporaryDirectory();
    const source = await writeSourceFile(root, 'a.txt', 'hello');
    const io = createMemoryIO();

    const code = await runCli([source], io, {
      writer: createFakeWriter(),
    });

    expect(code).toBe(0);
    expect(io.stdoutText).toContain('a (1).txt');
    expect(io.stderrText).toContain(`正在读取：${source}`);
    expect(io.stderrText).not.toContain('如该目录受 DSM 管控');
  });

  it('相对路径按 cwd 解析', async () => {
    const root = await makeTemporaryDirectory();
    await writeSourceFile(root, 'a.txt', 'hello');
    const io = createMemoryIO();

    const code = await runCli(['a.txt'], io, {
      cwd: root,
      writer: createFakeWriter(),
    });

    expect(code).toBe(0);
    expect(io.stdoutText).toContain(
      path.join(root, 'a (1).txt'),
    );
  });
});
