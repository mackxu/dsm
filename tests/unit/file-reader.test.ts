import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
