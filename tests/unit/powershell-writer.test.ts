import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerShellWriter, type Logger } from '@dsm/desktop-runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

async function makeHelper(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-ps-test-'));
  temporaryDirectories.push(root);
  const helperPath = path.join(root, 'dsm-file-writer.ps1');
  await fs.writeFile(helperPath, '# test helper\n');
  return helperPath;
}

function createWriter(options: {
  helperPath: string;
  configuredPath?: string | null;
  queryVersion?: (command: string) => Promise<string | null>;
  spawnImpl?: typeof import('node:child_process').spawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}): PowerShellWriter {
  return new PowerShellWriter({
    helperPath: options.helperPath,
    getConfiguredPath: async () => options.configuredPath ?? null,
    queryVersion: options.queryVersion ?? (async () => '5.1.19041'),
    spawnImpl: options.spawnImpl,
    platform: options.platform ?? 'win32',
    env: options.env ?? { PATH: '', SystemRoot: 'C:\\Windows' },
    logger: options.logger,
  });
}

describe('PowerShellWriter', () => {
  it('spawns PowerShell with the fixed helper and streams result JSON', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const writer = createWriter({
      helperPath,
      configuredPath: 'C:\\PS\\powershell.exe',
      spawnImpl:
        spawnImpl as unknown as typeof import('node:child_process').spawn,
    });
    const content = Buffer.from('written bytes');
    const hash = createHash('sha256').update(content).digest('hex');

    child.stdin.on('finish', () => {
      child.stdout.once('end', () => child.emit('close', 0));
      child.stdout.end(JSON.stringify({ bytes: content.length, sha256: hash }));
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 5_000 },
    );
    session.stdin.end(content);
    const result = await session.completed;

    expect(result.tempPath).toBe(
      path.join(path.dirname(helperPath), '.dsm-copy-x.part'),
    );
    expect(result.bytesWritten).toBe(content.length);
    expect(result.sha256).toBe(hash);

    const [command, args, spawnOptions] = spawnImpl.mock
      .calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdio: string[] },
    ];
    expect(command).toBe('C:\\PS\\powershell.exe');
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
    ]);
    expect(spawnOptions.env).toMatchObject({
      COPY_TARGET_DIR: path.dirname(helperPath),
      COPY_FILE_NAME: 'note.txt',
      COPY_TEMP_NAME: '.dsm-copy-x.part',
    });
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('decodes a base64 stderr message on failure', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const writer = createWriter({
      helperPath,
      configuredPath: 'powershell.exe',
      spawnImpl: (() =>
        child) as unknown as typeof import('node:child_process').spawn,
    });
    const messageBase64 = Buffer.from('磁盘已满', 'utf8').toString('base64');

    child.stdin.on('finish', () => {
      child.stderr.once('end', () => child.emit('close', 1));
      child.stderr.end(JSON.stringify({ code: 'WRITE_FAILED', messageBase64 }));
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 5_000 },
    );
    session.stdin.end('data');

    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      message: '磁盘已满',
    });
  });

  it('logs exit code and stderr when PowerShell exits non-zero', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const log = vi.fn().mockResolvedValue(undefined);
    const writer = createWriter({
      helperPath,
      configuredPath: 'powershell.exe',
      spawnImpl: (() =>
        child) as unknown as typeof import('node:child_process').spawn,
      logger: { log } as unknown as Logger,
    });
    const messageBase64 = Buffer.from('磁盘已满', 'utf8').toString('base64');

    child.stdin.on('finish', () => {
      child.stderr.once('end', () => child.emit('close', 1, null));
      child.stderr.end(JSON.stringify({ code: 'WRITE_FAILED', messageBase64 }));
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 5_000 },
    );
    session.stdin.end('data');

    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        'ERROR',
        'WRITE',
        expect.stringContaining('PowerShell 写入失败'),
        expect.objectContaining({
          details: expect.objectContaining({
            exitCode: 1,
            stderr: expect.stringContaining('messageBase64'),
          }),
        }),
      );
    });
  });

  it('rejects invalid stdout JSON', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const writer = createWriter({
      helperPath,
      configuredPath: 'powershell.exe',
      spawnImpl: (() =>
        child) as unknown as typeof import('node:child_process').spawn,
    });

    child.stdin.on('finish', () => {
      child.stdout.once('end', () => child.emit('close', 0));
      child.stdout.end('not-json');
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 5_000 },
    );
    session.stdin.end('data');

    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('aborts by killing the child process', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const writer = createWriter({
      helperPath,
      configuredPath: 'powershell.exe',
      spawnImpl: (() =>
        child) as unknown as typeof import('node:child_process').spawn,
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 5_000 },
    );
    session.abort();

    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('times out when PowerShell never exits', async () => {
    const helperPath = await makeHelper();
    const child = createFakeChild();
    const writer = createWriter({
      helperPath,
      configuredPath: 'powershell.exe',
      spawnImpl: (() =>
        child) as unknown as typeof import('node:child_process').spawn,
    });

    const session = await writer.open(
      path.dirname(helperPath),
      'note.txt',
      '.dsm-copy-x.part',
      { timeoutMs: 10 },
    );

    await expect(session.completed).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      message: 'PowerShell 写入超时',
    });
  });

  it('reports a missing helper before spawning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-ps-test-'));
    temporaryDirectories.push(root);
    const spawnImpl = vi.fn();
    const writer = createWriter({
      helperPath: path.join(root, 'missing.ps1'),
      configuredPath: 'powershell.exe',
      spawnImpl:
        spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    await expect(
      writer.open(root, 'note.txt', '.dsm-copy-x.part', { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'WRITER_UNAVAILABLE' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('never falls back when an explicit PowerShell path is invalid', async () => {
    const helperPath = await makeHelper();
    const queryVersion = vi.fn(async (command: string) =>
      command === 'C:\\bad\\powershell.exe' ? null : '5.1.19041',
    );
    const spawnImpl = vi.fn();
    const writer = createWriter({
      helperPath,
      configuredPath: 'C:\\bad\\powershell.exe',
      queryVersion,
      spawnImpl:
        spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    await expect(writer.checkAvailability()).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
    expect(queryVersion).toHaveBeenCalledTimes(1);
    expect(queryVersion).toHaveBeenCalledWith('C:\\bad\\powershell.exe');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('falls back through auto-detected PowerShell candidates', async () => {
    const helperPath = await makeHelper();
    const queryVersion = vi.fn(async (command: string) =>
      command === '/usr/bin/pwsh' ? null : '7.4.6',
    );
    const writer = createWriter({
      helperPath,
      queryVersion,
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
    });

    const result = await writer.checkAvailability();
    expect(result).toEqual({
      writerPath: '/opt/homebrew/bin/pwsh',
      writerVersion: '7.4.6',
      writerSource: 'auto',
    });
  });

  it('avoids the 6-argument File.Open overload in the helper script', async () => {
    const script = await fs.readFile(
      path.resolve('resources/dsm-file-writer.ps1'),
      'utf8',
    );
    expect(script).not.toContain('[System.IO.FileOptions]::SequentialScan');
    expect(script).not.toContain('[int]65536');
    expect(script).toContain('[System.IO.File]::Open(');
    expect(script).toContain('[System.IO.FileMode]::CreateNew');
  });

  it('stores the helper script as UTF-8 with BOM for PowerShell 5.1', async () => {
    const script = await fs.readFile(
      path.resolve('resources/dsm-file-writer.ps1'),
    );
    expect([...script.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
