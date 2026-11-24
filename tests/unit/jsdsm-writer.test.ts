import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PowerShellWriter,
  parseWriterError,
  parseWriterOutput,
} from 'jsdsm';

import {
  cleanupTemporaryDirectories,
  makeTemporaryDirectory,
} from './jsdsm-fixtures.ts';

const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { env?: NodeJS.ProcessEnv };
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  finish(code: number, stdout = '', stderr = ''): void {
    if (stdout) {
      this.stdout.write(stdout);
    }
    if (stderr) {
      this.stderr.write(stderr);
    }
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

function createSpawn(
  child: FakeChildProcess,
  calls: SpawnCall[],
): typeof spawn {
  return ((command: string, args: readonly string[], options: SpawnCall['options']) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as typeof spawn;
}

async function createTestWriter(
  overrides: Partial<ConstructorParameters<typeof PowerShellWriter>[0]> = {},
): Promise<{
  directory: string;
  helperPath: string;
  options: ConstructorParameters<typeof PowerShellWriter>[0];
}> {
  const directory = await makeTemporaryDirectory();
  const helperPath = path.join(directory, 'dsm-file-writer.ps1');
  await fs.writeFile(helperPath, '# test helper');
  return {
    directory,
    helperPath,
    options: {
      helperPath,
      configuredPath: '/fake/pwsh',
      queryVersion: async () => '7.4.0',
      ...overrides,
    },
  };
}

afterEach(cleanupTemporaryDirectories);

describe('PowerShellWriter 解析', () => {
  it('优先使用显式路径', async () => {
    const { options } = await createTestWriter({
      configuredPath: '/opt/pwsh',
      queryVersion: async (command) =>
        command === '/opt/pwsh' ? '7.4.0' : null,
    });
    const writer = new PowerShellWriter(options);
    await expect(writer.resolve()).resolves.toEqual({
      command: '/opt/pwsh',
      version: '7.4.0',
      source: 'option',
    });
  });

  it('去掉路径两侧的引号', async () => {
    const { options } = await createTestWriter({
      configuredPath: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
      queryVersion: async (command) =>
        command === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
          ? '7.4.0'
          : null,
    });
    const writer = new PowerShellWriter(options);
    await expect(writer.resolve()).resolves.toMatchObject({
      command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });
  });

  it('其次使用 JSDSM_WRITER_PATH', async () => {
    const { options } = await createTestWriter({
      configuredPath: null,
      env: { JSDSM_WRITER_PATH: '/env/pwsh' },
      queryVersion: async (command) =>
        command === '/env/pwsh' ? '7.4.0' : null,
    });
    const writer = new PowerShellWriter(options);
    await expect(writer.resolve()).resolves.toEqual({
      command: '/env/pwsh',
      version: '7.4.0',
      source: 'environment',
    });
  });

  it('最后自动探测候选路径', async () => {
    const { options } = await createTestWriter({
      configuredPath: null,
      env: {},
      candidates: () => ['/missing/pwsh', '/auto/pwsh'],
      queryVersion: async (command) =>
        command === '/auto/pwsh' ? '5.1.19041' : null,
    });
    const writer = new PowerShellWriter(options);
    await expect(writer.resolve()).resolves.toEqual({
      command: '/auto/pwsh',
      version: '5.1.19041',
      source: 'auto',
    });
  });

  it('显式路径不可执行时不回退', async () => {
    const candidates = () => {
      throw new Error('不应调用自动探测');
    };
    const { options } = await createTestWriter({
      configuredPath: '/bad/pwsh',
      queryVersion: async () => null,
      candidates,
    });
    const writer = new PowerShellWriter(options);
    await expect(writer.resolve()).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
  });
});

describe('PowerShellWriter 写入会话', () => {
  it('传递环境变量并解析成功结果', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const calls: SpawnCall[] = [];
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, calls),
    });

    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
    );
    child.finish(
      0,
      JSON.stringify({ bytes: 5, sha256: HELLO_SHA256 }),
    );

    await expect(session.completed).resolves.toEqual({
      bytesWritten: 5,
      sha256: HELLO_SHA256,
      tempPath: path.join(directory, '.tmp.part'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/fake/pwsh');
    expect(calls[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.helperPath,
    ]);
    expect(calls[0]?.options.env?.COPY_TARGET_DIR).toBe(directory);
    expect(calls[0]?.options.env?.COPY_FILE_NAME).toBe('a.txt');
    expect(calls[0]?.options.env?.COPY_TEMP_NAME).toBe('.tmp.part');
  });

  it('abort 会终止进程并返回 CANCELLED', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, []),
    });
    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
    );
    session.abort();
    await expect(session.completed).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(child.killed).toBe(true);
  });

  it('超时会终止进程并报告超时', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, []),
    });
    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
      { timeoutMs: 10 },
    );
    const error = await session.completed.catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: 'WRITE_FAILED' });
    expect((error as Error).message).toContain('超时');
    expect(child.killed).toBe(true);
  });

  it('spawn 失败映射为 WRITER_UNAVAILABLE', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, []),
    });
    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
    );
    child.emit('error', new Error('spawn failed'));
    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
  });

  it('无效 stdout 输出映射为 WRITE_FAILED', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, []),
    });
    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
    );
    child.finish(0, 'not-json');
    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('解码 stderr 中的 messageBase64', async () => {
    const { directory, options } = await createTestWriter();
    const child = new FakeChildProcess();
    const writer = new PowerShellWriter({
      ...options,
      spawnImpl: createSpawn(child, []),
    });
    const session = await writer.open(
      directory,
      'a.txt',
      '.tmp.part',
    );
    child.finish(
      1,
      '',
      JSON.stringify({
        code: 'WRITE_FAILED',
        messageBase64: Buffer.from('写入被拒绝', 'utf8').toString('base64'),
      }),
    );
    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      message: '写入被拒绝',
    });
  });

  it('helper 脚本不存在时直接报错', async () => {
    const { directory, options } = await createTestWriter();
    const writer = new PowerShellWriter({
      ...options,
      helperPath: path.join(directory, 'missing.ps1'),
    });
    await expect(
      writer.open(directory, 'a.txt', '.tmp.part'),
    ).rejects.toMatchObject({ code: 'WRITER_UNAVAILABLE' });
  });
});

describe('writer 协议解析', () => {
  it('解析带 BOM 与空白的 JSON', () => {
    expect(
      parseWriterOutput(
        `\uFEFF {"bytes":5,"sha256":"${HELLO_SHA256}"} \n`,
        '/tmp',
        '.tmp.part',
      ),
    ).toEqual({
      bytesWritten: 5,
      sha256: HELLO_SHA256,
      tempPath: path.join('/tmp', '.tmp.part'),
    });
  });

  it('拒绝非法字节数或哈希', () => {
    expect(
      parseWriterOutput('{"bytes":-1,"sha256":"abc"}', '/tmp', '.part'),
    ).toBeNull();
    expect(
      parseWriterOutput('{"bytes":1.5,"sha256":"abc"}', '/tmp', '.part'),
    ).toBeNull();
    expect(
      parseWriterOutput('{"bytes":1,"sha256":"abc"}', '/tmp', '.part'),
    ).toBeNull();
  });

  it('解析纯文本错误', () => {
    const error = parseWriterError('boom', 1);
    expect(error.code).toBe('WRITE_FAILED');
    expect(error.message).toContain('boom');
  });
});
