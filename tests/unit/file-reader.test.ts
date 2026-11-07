import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DsmError } from '@dsm/core';

import { WhitelistedFileReader } from '../../apps/desktop/src/main/whitelisted-file-reader.ts';
import { NodeExecutableResolver } from '../../apps/desktop/src/main/node-path.ts';

const helperPath = path.resolve('resources/dsm-file-reader.cjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface HelperResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function runHelper(args: string[]): Promise<HelperResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('close', (code) => {
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-reader-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('dsm-file-reader helper', () => {
  it('writes the plaintext bytes to stdout', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    const content = Buffer.from('decrypted content');
    await fs.writeFile(filePath, content);

    const result = await runHelper([filePath, String(1024)]);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(content)).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('exits with code 2 when the file exceeds the limit', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    await fs.writeFile(filePath, '0123456789');

    const result = await runHelper([filePath, '4']);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'FILE_TOO_LARGE',
      message: '文件超过上传大小上限',
    });
    expect(result.stdout.length).toBeLessThanOrEqual(4);
  });

  it('exits with code 1 when the file is missing', async () => {
    const root = await makeTemporaryDirectory();

    const result = await runHelper([path.join(root, 'missing.txt'), '1024']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });

  it('rejects empty files', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'empty.txt');
    await fs.writeFile(filePath, '');

    const result = await runHelper([filePath, '1024']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });
});

describe('WhitelistedFileReader', () => {
  it('fails without reading locally when auto detection finds no Node', async () => {
    vi.spyOn(NodeExecutableResolver.prototype, 'resolve').mockResolvedValue(null);

    const reader = new WhitelistedFileReader({
      helperPath,
      getConfiguredNodePath: async () => null,
    });
    // 路径故意不存在：旧实现会回退 fs.readFile 并抛出 ENOENT，
    // 现在必须在触碰文件系统之前以 READER_UNAVAILABLE 失败。
    const missingPath = path.join(
      os.tmpdir(),
      `dsm-reader-missing-${Date.now()}.txt`,
    );

    const error: unknown = await reader
      .read(missingPath, { maxBytes: 1024 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DsmError);
    expect(error).toMatchObject({
      code: 'READER_UNAVAILABLE',
      stage: 'CHECK',
    });
    expect((error as Error).message).toContain('未找到可用的 Node');
  });
});
