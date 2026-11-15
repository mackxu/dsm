import { createHash } from 'node:crypto';
import { appendFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CopyController,
  DsmError,
  type CopyConfig,
  type FileReadStream,
  type FileStreamReader,
  type FileStreamWriter,
  type FileWriteResult,
} from '@dsm/core';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-copy-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function copyConfig(saveDirectory: string): CopyConfig {
  return {
    schemaVersion: 1,
    saveDirectory,
    preferredReader: 'node',
    nodeReaderPath: null,
    pythonReaderPath: null,
    powershellPath: null,
    maxCopyBytes: 10 * 1024 * 1024,
    copyTimeoutMs: 30_000,
  };
}

function readerFromContent(content: Buffer): FileStreamReader {
  return async (): Promise<FileReadStream> => {
    let settled = false;
    let resolveDone!: (bytes: number) => void;
    let rejectDone!: (error: Error) => void;
    const stream = Readable.from([content]);
    const completed = new Promise<number>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    completed.catch(() => {});
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolveDone(content.length);
    });
    stream.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      rejectDone(error);
    });
    return {
      stream,
      completed,
      abort: () => {
        stream.destroy();
        if (settled) return;
        settled = true;
        rejectDone(
          new DsmError('FILE_READ_FAILED', '读取已取消', 'CHECK', true),
        );
      },
    };
  };
}

function failingReader(error: Error): FileStreamReader {
  return async () => {
    throw error;
  };
}

interface FakeWriterOptions {
  mutateResult?: (result: FileWriteResult) => FileWriteResult;
  failOpen?: Error;
  failComplete?: Error;
  onFinish?: () => void;
}

function writerFor(options: FakeWriterOptions = {}): FileStreamWriter {
  return async (
    targetDirectory: string,
    _fileName: string,
    tempName: string,
  ) => {
    if (options.failOpen) throw options.failOpen;
    const tempPath = path.join(targetDirectory, tempName);
    const handle = await fs.open(tempPath, 'w');
    const hash = createHash('sha256');
    let bytes = 0;
    let settled = false;
    let resolveDone!: (result: FileWriteResult) => void;
    let rejectDone!: (error: Error) => void;
    const completed = new Promise<FileWriteResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    completed.catch(() => {});

    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        void handle
          .write(chunk)
          .then(() => callback())
          .catch(callback);
      },
      final(callback) {
        options.onFinish?.();
        void handle
          .close()
          .then(() => {
            settled = true;
            if (options.failComplete) {
              rejectDone(options.failComplete);
            } else {
              const result: FileWriteResult = {
                bytesWritten: bytes,
                sha256: hash.digest('hex'),
                tempPath,
              };
              resolveDone(
                options.mutateResult ? options.mutateResult(result) : result,
              );
            }
            callback();
          })
          .catch(callback);
      },
    });
    stdin.on('error', () => {});

    return {
      stdin,
      completed,
      abort: () => {
        if (settled) return;
        settled = true;
        stdin.destroy();
        void handle.close().catch(() => {});
        rejectDone(new DsmError('WRITE_FAILED', '写入已取消', 'COPY', true));
      },
    };
  };
}

function hangingReader(): {
  reader: FileStreamReader;
  abort: () => void;
} {
  const stream = new Readable({ read() {} });
  let settled = false;
  let rejectDone!: (error: Error) => void;
  const completed = new Promise<number>((_resolve, reject) => {
    rejectDone = reject;
  });
  completed.catch(() => {});

  function abort(): void {
    stream.destroy();
    if (settled) return;
    settled = true;
    rejectDone(new DsmError('FILE_READ_FAILED', '读取已取消', 'CHECK', true));
  }

  return {
    reader: async () => ({ stream, completed, abort }),
    abort,
  };
}

function createController(options: {
  saveDirectory: string;
  documentsDirectory: string;
  openReadStream: FileStreamReader;
  openWriteSession: FileStreamWriter;
  onUpdate?: (snapshot: ReturnType<CopyController['getCurrentTask']>) => void;
}): CopyController {
  return new CopyController({
    getConfig: async () => copyConfig(options.saveDirectory),
    getDocumentsDirectory: () => options.documentsDirectory,
    openReadStream: options.openReadStream,
    openWriteSession: options.openWriteSession,
    onUpdate: (snapshot) => options.onUpdate?.(snapshot),
    now: () => new Date('2026-01-02T03:04:05.678Z'),
    createId: () => 'abcdef12-3456-7890-abcd-ef1234567890',
  });
}

describe('CopyController', () => {
  it('streams the plaintext, verifies it, and renames the temp file', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('hello unlock');
    await fs.writeFile(source, content);
    const updates: unknown[] = [];

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor(),
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('SUCCESS');
    expect(snapshot.targetDirectory).toBe(
      path.join(saveDirectory, '20260102-110405-678-abcdef'),
    );
    expect(snapshot.targetPath).toBe(
      path.join(snapshot.targetDirectory as string, 'note.txt'),
    );
    expect(await fs.readFile(snapshot.targetPath as string)).toEqual(content);
    expect(snapshot.bytesRead).toBe(content.length);
    expect(snapshot.bytesWritten).toBe(content.length);
    expect(snapshot.bytesProcessed).toBe(content.length);
    expect(snapshot.failure).toBeNull();
    expect(updates.length).toBeGreaterThan(0);
    expect(await fs.readdir(saveDirectory)).toEqual([
      '20260102-110405-678-abcdef',
    ]);
  });

  it('fails cleanly when the reader cannot be opened', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    await fs.writeFile(source, 'content');

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: failingReader(
        new DsmError('READER_UNAVAILABLE', '未找到可用的前置依赖', 'CHECK'),
      ),
      openWriteSession: writerFor(),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('READER_UNAVAILABLE');
    expect(snapshot.recoveryActions).toEqual(['RETRY_COPY']);
    await expect(
      fs.stat(snapshot.targetDirectory as string),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails cleanly when the writer cannot be opened', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('content');
    await fs.writeFile(source, content);

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor({
        failOpen: new DsmError(
          'WRITER_UNAVAILABLE',
          '未找到可用的 PowerShell',
          'CHECK',
        ),
      }),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('WRITER_UNAVAILABLE');
    expect(await fs.readdir(saveDirectory)).toEqual([]);
  });

  it('rejects a writer hash mismatch and removes the temp file', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('content');
    await fs.writeFile(source, content);

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor({
        mutateResult: (result) => ({ ...result, sha256: '0'.repeat(64) }),
      }),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('WRITE_VERIFY_FAILED');
    expect(snapshot.failure?.message).toContain('哈希不一致');
    expect(await fs.readdir(saveDirectory)).toEqual([]);
  });

  it('rejects a writer byte-count mismatch', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('content');
    await fs.writeFile(source, content);

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor({
        mutateResult: (result) => ({
          ...result,
          bytesWritten: result.bytesWritten + 1,
        }),
      }),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('WRITE_VERIFY_FAILED');
    expect(await fs.readdir(saveDirectory)).toEqual([]);
  });

  it('rejects a writer completion error', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('content');
    await fs.writeFile(source, content);

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor({
        failComplete: new DsmError(
          'WRITE_FAILED',
          'PowerShell 写入失败',
          'COPY',
          true,
        ),
      }),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('WRITE_FAILED');
    expect(await fs.readdir(saveDirectory)).toEqual([]);
  });

  it('detects a source file change during the copy', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('content');
    await fs.writeFile(source, content);

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor({
        onFinish: () => appendFileSync(source, 'x'),
      }),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('FILE_CHANGED');
    expect(await fs.readdir(saveDirectory)).toEqual([]);
  });

  it('does not overwrite an existing target file', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    const content = Buffer.from('new content');
    await fs.writeFile(source, content);
    const targetDirectory = path.join(
      saveDirectory,
      '20260102-110405-678-abcdef',
    );
    const targetPath = path.join(targetDirectory, 'note.txt');
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.writeFile(targetPath, 'old content');

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: readerFromContent(content),
      openWriteSession: writerFor(),
    });

    const snapshot = await controller.start(source);
    expect(snapshot.status).toBe('FAILED');
    expect(snapshot.failure?.code).toBe('WRITE_FAILED');
    expect(await fs.readFile(targetPath, 'utf8')).toBe('old content');
  });

  it('rejects a second task while one is active', async () => {
    const root = await makeTemporaryDirectory();
    const saveDirectory = path.join(root, 'save');
    const source = path.join(root, 'note.txt');
    await fs.writeFile(source, 'content');
    const hanging = hangingReader();

    const controller = createController({
      saveDirectory,
      documentsDirectory: root,
      openReadStream: hanging.reader,
      openWriteSession: writerFor(),
    });

    const first = controller.start(source);
    await vi.waitFor(() => {
      expect(controller.getCurrentTask()?.status).toBe('COPYING');
    });

    await expect(controller.start(source)).rejects.toMatchObject({
      code: 'TASK_BUSY',
    });

    controller.abort();
    const snapshot = await first;
    expect(snapshot.status).toBe('FAILED');
  });
});
