import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DsmError, type ReaderKind, type ReaderSelection } from '@dsm/core';

import type { Logger } from '../../apps/desktop/src/main/logger.ts';
import {
  buildHelperInvocation,
  WhitelistedFileReader,
} from '../../apps/desktop/src/main/whitelisted-file-reader.ts';
import {
  readerLabel,
  resolveReaderChain,
} from '../../apps/desktop/src/main/reader-chain.ts';
import type {
  ReaderResolver,
  ResolvedReader,
} from '../../apps/desktop/src/main/reader-executable.ts';

const helperPath = path.resolve('resources/dsm-file-reader.cjs');
const pythonHelperPath = path.resolve('resources/dsm-file-reader.py');
const pythonCommand = findPython();
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

function runHelper(
  command: string,
  helper: string,
  args: string[],
): Promise<HelperResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [helper, ...args], {
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

function runPythonHelper(args: string[]): Promise<HelperResult> {
  if (!pythonCommand) {
    return Promise.reject(new Error('Python 不可用'));
  }
  return runHelper(pythonCommand, pythonHelperPath, args);
}

function findPython(): string | null {
  const candidates = [
    process.env.DSM_PYTHON_PATH,
    process.platform === 'win32' ? 'python.exe' : 'python3',
    process.platform === 'win32' ? 'python3.exe' : 'python',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      [
        '-I',
        '-S',
        '-B',
        '-c',
        "import sys; print('%d.%d.%d' % sys.version_info[:3])",
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    if (
      result.status === 0 &&
      /^3\.\d+\.\d+$/.test((result.stdout ?? '').trim())
    ) {
      return candidate;
    }
  }
  return null;
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-reader-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeResolver(
  kind: ReaderKind,
  resolve: ReaderResolver['resolve'],
): ReaderResolver {
  return { kind, resolve, resetAutoDetection: vi.fn() };
}

function missingResolver(kind: ReaderKind): ReaderResolver {
  return fakeResolver(kind, vi.fn().mockResolvedValue(null));
}

function resolvedReader(
  kind: ReaderKind,
  command: string,
  source: 'config' | 'environment' | 'auto' = 'auto',
): ResolvedReader {
  return {
    kind,
    command,
    version: kind === 'node' ? '22.13.0' : '3.14.5',
    source,
  };
}

function selection(
  preferredReader: ReaderKind = 'node',
): ReaderSelection {
  return {
    preferredReader,
    nodeReaderPath: null,
    pythonReaderPath: null,
  };
}

function createReader(options: {
  node?: ReaderResolver;
  python?: ReaderResolver;
  readerSelection?: ReaderSelection;
  nodeHelperPath?: string;
  pythonHelperPath?: string;
  logger?: Logger;
} = {}): WhitelistedFileReader {
  return new WhitelistedFileReader({
    nodeHelperPath: options.nodeHelperPath ?? helperPath,
    pythonHelperPath: options.pythonHelperPath ?? helperPath,
    getReaderSelection: async () =>
      options.readerSelection ?? selection(),
    logger: options.logger,
    resolvers: {
      node: options.node ?? missingResolver('node'),
      python: options.python ?? missingResolver('python'),
    },
  });
}

describe('dsm-file-reader helper', () => {
  it('writes the plaintext bytes to stdout', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    const content = Buffer.from('decrypted content');
    await fs.writeFile(filePath, content);

    const result = await runHelper(process.execPath, helperPath, [
      filePath,
      String(1024),
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(content)).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('exits with code 2 when the file exceeds the limit', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    await fs.writeFile(filePath, '0123456789');

    const result = await runHelper(process.execPath, helperPath, [
      filePath,
      '4',
    ]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'FILE_TOO_LARGE',
      message: '文件超过上传大小上限',
    });
    expect(result.stdout.length).toBeLessThanOrEqual(4);
  });

  it('exits with code 1 when the file is missing', async () => {
    const root = await makeTemporaryDirectory();

    const result = await runHelper(process.execPath, helperPath, [
      path.join(root, 'missing.txt'),
      '1024',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });

  it('rejects empty files', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'empty.txt');
    await fs.writeFile(filePath, '');

    const result = await runHelper(process.execPath, helperPath, [
      filePath,
      '1024',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });
});

describe.skipIf(!pythonCommand)('dsm-file-reader.py helper', () => {
  it('writes the plaintext bytes to stdout', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    const content = Buffer.from('decrypted content');
    await fs.writeFile(filePath, content);

    const result = await runPythonHelper([filePath, String(1024)]);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(content)).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('writes binary bytes without text conversion', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.bin');
    const content = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x01]);
    await fs.writeFile(filePath, content);

    const result = await runPythonHelper([filePath, String(1024)]);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(content)).toBe(true);
  });

  it('exits with code 2 when the file exceeds the limit', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    await fs.writeFile(filePath, '0123456789');

    const result = await runPythonHelper([filePath, '4']);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'FILE_TOO_LARGE',
      message: '文件超过上传大小上限',
    });
    expect(result.stdout.length).toBeLessThanOrEqual(4);
  });

  it('exits with code 1 when the file is missing', async () => {
    const root = await makeTemporaryDirectory();

    const result = await runPythonHelper([
      path.join(root, 'missing.txt'),
      '1024',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });

  it('rejects empty files', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'empty.txt');
    await fs.writeFile(filePath, '');

    const result = await runPythonHelper([filePath, '1024']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('FILE_READ_FAILED');
  });

  it('handles paths with spaces and Chinese characters', async () => {
    const root = await makeTemporaryDirectory();
    const directory = path.join(root, 'dsm 测试');
    await fs.mkdir(directory);
    const filePath = path.join(directory, 'test file.txt');
    const content = Buffer.from('unicode path');
    await fs.writeFile(filePath, content);

    const result = await runPythonHelper([filePath, String(1024)]);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(content)).toBe(true);
  });

  it('rejects invalid arguments', async () => {
    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    await fs.writeFile(filePath, 'content');

    const missing = await runPythonHelper([]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).code).toBe('FILE_READ_FAILED');

    const invalidLimit = await runPythonHelper([filePath, '0']);
    expect(invalidLimit.code).toBe(1);
    expect(JSON.parse(invalidLimit.stderr).code).toBe('FILE_READ_FAILED');
  });
});

describe('resolveReaderChain', () => {
  it('uses the preferred reader when it resolves', async () => {
    const node = fakeResolver(
      'node',
      vi.fn().mockResolvedValue(resolvedReader('node', '/usr/bin/node')),
    );
    const python = fakeResolver('python', vi.fn());

    const result = await resolveReaderChain(selection('node'), { node, python });

    expect(result.reader.kind).toBe('node');
    expect(result.fallbackUsed).toBe(false);
    expect(python.resolve).not.toHaveBeenCalled();
  });

  it('falls back to the other reader when the preferred one is missing', async () => {
    const node = missingResolver('node');
    const python = fakeResolver(
      'python',
      vi.fn().mockResolvedValue(resolvedReader('python', '/usr/bin/python3')),
    );

    const result = await resolveReaderChain(selection('node'), { node, python });

    expect(result.reader.kind).toBe('python');
    expect(result.fallbackUsed).toBe(true);
  });

  it('does not fall back when the preferred resolver throws', async () => {
    const node = fakeResolver(
      'node',
      vi
        .fn()
        .mockRejectedValue(
          new DsmError('READER_UNAVAILABLE', '配置的 Node 不可执行', 'CHECK'),
        ),
    );
    const python = fakeResolver('python', vi.fn());

    await expect(
      resolveReaderChain(selection('node'), { node, python }),
    ).rejects.toMatchObject({ code: 'READER_UNAVAILABLE' });
    expect(python.resolve).not.toHaveBeenCalled();
  });

  it('reports both readers when neither is available', async () => {
    const node = missingResolver('node');
    const python = missingResolver('python');

    await expect(
      resolveReaderChain(selection('node'), { node, python }),
    ).rejects.toMatchObject({
      code: 'READER_UNAVAILABLE',
      message: expect.stringContaining('Node 或 Python'),
    });
  });
});

describe('buildHelperInvocation', () => {
  const helpers = { node: '/helpers/reader.cjs', python: '/helpers/reader.py' };

  it('builds the Node invocation', () => {
    expect(
      buildHelperInvocation(
        resolvedReader('node', '/usr/bin/node'),
        helpers,
        '/tmp/file.bin',
        1024,
      ),
    ).toEqual({
      command: '/usr/bin/node',
      args: ['/helpers/reader.cjs', '/tmp/file.bin', '1024'],
    });
  });

  it('builds the Python invocation', () => {
    expect(
      buildHelperInvocation(
        resolvedReader('python', '/usr/bin/python3'),
        helpers,
        '/tmp/file.bin',
        1024,
      ),
    ).toEqual({
      command: '/usr/bin/python3',
      args: [
        '-I',
        '-S',
        '-B',
        '-u',
        '/helpers/reader.py',
        '/tmp/file.bin',
        '1024',
      ],
    });
  });
});

describe('WhitelistedFileReader', () => {
  it('fails without reading locally when neither reader is available', async () => {
    const reader = createReader();
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
    expect((error as Error).message).toContain('Node 或 Python');
  });

  it('logs the attempted reader path before spawning', async () => {
    const command = path.join(
      os.tmpdir(),
      `dsm-reader-missing-node-${Date.now()}`,
    );
    const node = fakeResolver(
      'node',
      vi
        .fn()
        .mockResolvedValue(resolvedReader('node', command, 'config')),
    );
    const log = vi.fn().mockResolvedValue(undefined);
    const reader = createReader({
      node,
      logger: { log } as unknown as Logger,
    });

    const error: unknown = await reader
      .read(path.join(os.tmpdir(), 'unused.txt'), { maxBytes: 1024 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DsmError);
    expect(log).toHaveBeenCalledWith(
      'INFO',
      'FILE',
      '开始通过外部 Node 读取待上传文件',
      {
        details: {
          readerKind: 'node',
          readerPath: command,
          readerVersion: '22.13.0',
          readerSource: 'config',
          preferredReader: 'node',
          fallbackUsed: false,
        },
      },
    );
  });

  it('does not fall back when the preferred resolver throws', async () => {
    const node = fakeResolver(
      'node',
      vi
        .fn()
        .mockRejectedValue(
          new DsmError('READER_UNAVAILABLE', '配置的 Node 不可执行', 'CHECK'),
        ),
    );
    const pythonResolve = vi.fn().mockResolvedValue(null);
    const python = fakeResolver('python', pythonResolve);
    const reader = createReader({ node, python });

    const error: unknown = await reader
      .read(path.join(os.tmpdir(), 'unused.txt'), { maxBytes: 1024 })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'READER_UNAVAILABLE' });
    expect(pythonResolve).not.toHaveBeenCalled();
  });

  it('does not fall back when spawning the preferred reader fails', async () => {
    const command = path.join(
      os.tmpdir(),
      `dsm-reader-missing-node-${Date.now()}`,
    );
    const node = fakeResolver(
      'node',
      vi
        .fn()
        .mockResolvedValue(resolvedReader('node', command, 'config')),
    );
    const pythonResolve = vi.fn().mockResolvedValue(null);
    const python = fakeResolver('python', pythonResolve);
    const reader = createReader({ node, python });

    const error: unknown = await reader
      .read(path.join(os.tmpdir(), 'unused.txt'), { maxBytes: 1024 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DsmError);
    expect(pythonResolve).not.toHaveBeenCalled();
  });

  it('does not fall back when the helper is missing', async () => {
    const node = fakeResolver(
      'node',
      vi
        .fn()
        .mockResolvedValue(
          resolvedReader('node', process.execPath, 'config'),
        ),
    );
    const pythonResolve = vi.fn().mockResolvedValue(null);
    const python = fakeResolver('python', pythonResolve);
    const reader = createReader({
      node,
      python,
      nodeHelperPath: path.join(
        os.tmpdir(),
        `dsm-reader-missing-helper-${Date.now()}.cjs`,
      ),
    });

    const error: unknown = await reader
      .read(path.join(os.tmpdir(), 'unused.txt'), { maxBytes: 1024 })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'FILE_READ_FAILED' });
    expect(pythonResolve).not.toHaveBeenCalled();
  });
});

describe.skipIf(!pythonCommand)('WhitelistedFileReader Python fallback', () => {
  it('uses Python and logs the actual path when Node is missing', async () => {
    const python = pythonCommand;
    if (!python) return;

    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'sample.txt');
    const content = Buffer.from('fallback content');
    await fs.writeFile(filePath, content);

    const node = missingResolver('node');
    const pythonResolver = fakeResolver(
      'python',
      vi.fn().mockResolvedValue(resolvedReader('python', python, 'auto')),
    );
    const log = vi.fn().mockResolvedValue(undefined);
    const reader = createReader({
      node,
      python: pythonResolver,
      pythonHelperPath,
      logger: { log } as unknown as Logger,
    });

    const result = await reader.read(filePath, { maxBytes: 1024 });

    expect(result.equals(content)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'INFO',
      'FILE',
      '优先读取器 Node 不可用，使用 Python',
      {
        details: {
          readerKind: 'python',
          readerPath: python,
          readerVersion: '3.14.5',
          readerSource: 'auto',
          preferredReader: 'node',
        },
      },
    );
  });

  it('reports the fallback reader in the probe result', async () => {
    const python = pythonCommand;
    if (!python) return;

    const root = await makeTemporaryDirectory();
    const filePath = path.join(root, 'probe.txt');
    const content = Buffer.from('probe content');
    await fs.writeFile(filePath, content);

    const reader = createReader({
      node: missingResolver('node'),
      python: fakeResolver(
        'python',
        vi.fn().mockResolvedValue(resolvedReader('python', python, 'auto')),
      ),
      pythonHelperPath,
    });

    const result = await reader.probe(filePath, selection('node'));

    expect(result.fileName).toBe('probe.txt');
    expect(result.preferredReader).toBe('node');
    expect(result.usedReader).toBe('python');
    expect(result.fallbackUsed).toBe(true);
    expect(result.readerPath).toBe(python);
    expect(result.readerVersion).toBe('3.14.5');
    expect(result.readerSource).toBe('auto');
    expect(result.directSize).toBe(content.length);
    expect(result.readerSize).toBe(content.length);
    expect(result.identical).toBe(true);
  });
});

describe('readerLabel', () => {
  it('returns display labels', () => {
    expect(readerLabel('node')).toBe('Node');
    expect(readerLabel('python')).toBe('Python');
  });
});
