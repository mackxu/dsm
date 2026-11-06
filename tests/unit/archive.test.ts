import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  extractArchive,
  normalizeArchivePath,
} from '@dsm/core';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('archive extraction', () => {
  it('strips the GitLab root and writes a valid file', async () => {
    const root = await makeTemporaryDirectory();
    const zipPath = path.join(root, 'valid.zip');
    const zip = new AdmZip();
    zip.addFile('project-main/', Buffer.alloc(0));
    zip.addFile('project-main/docs/readme.txt', Buffer.from('hello'));
    zip.writeZip(zipPath);

    const result = await extractArchive(zipPath, root, 'result', {
      limits: DEFAULT_CONFIG.archiveLimits,
      requiredRelativePath: 'docs/readme.txt',
    });

    expect(await fs.readFile(path.join(result.finalDirectory, 'docs/readme.txt'), 'utf8'))
      .toBe('hello');
  });

  it('rejects path traversal before writing outside the destination', async () => {
    const root = await makeTemporaryDirectory();
    const zipPath = path.join(root, 'unsafe.zip');
    const zip = new AdmZip();
    const entry = zip.addFile('safe.txt', Buffer.from('unsafe'));
    entry.entryName = '../escaped.txt';
    zip.writeZip(zipPath);

    await expect(
      extractArchive(zipPath, root, 'result', {
        limits: DEFAULT_CONFIG.archiveLimits,
      }),
    ).rejects.toThrow(/不安全|越出/);
    await expect(fs.stat(path.join(path.dirname(root), 'escaped.txt'))).rejects.toThrow();
  });

  it('fails before creating a final directory when the uploaded file is absent', async () => {
    const root = await makeTemporaryDirectory();
    const zipPath = path.join(root, 'missing.zip');
    const zip = new AdmZip();
    zip.addFile('project-main/other.txt', Buffer.from('other'));
    zip.writeZip(zipPath);

    await expect(
      extractArchive(zipPath, root, 'missing-result', {
        limits: DEFAULT_CONFIG.archiveLimits,
        requiredRelativePath: 'uploaded.txt',
      }),
    ).rejects.toThrow(/缺少目标文件/);
    await expect(fs.stat(path.join(root, 'missing-result'))).rejects.toThrow();
  });

  it('keeps only the requested file and skips every other entry', async () => {
    const root = await makeTemporaryDirectory();
    const zipPath = path.join(root, 'only.zip');
    const zip = new AdmZip();
    zip.addFile('project-main/', Buffer.alloc(0));
    zip.addFile('project-main/uploaded.txt', Buffer.from('uploaded'));
    zip.addFile('project-main/other.txt', Buffer.from('other'));
    zip.addFile('project-main/docs/readme.txt', Buffer.from('docs'));
    zip.writeZip(zipPath);

    const result = await extractArchive(zipPath, root, 'result', {
      limits: DEFAULT_CONFIG.archiveLimits,
      requiredRelativePath: 'uploaded.txt',
      onlyRelativePath: 'uploaded.txt',
    });

    expect(
      result.extractedFiles.map((filePath) =>
        path.relative(result.finalDirectory, filePath),
      ),
    ).toEqual(['uploaded.txt']);
    expect(
      await fs.readFile(path.join(result.finalDirectory, 'uploaded.txt'), 'utf8'),
    ).toBe('uploaded');
    await expect(
      fs.stat(path.join(result.finalDirectory, 'other.txt')),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(result.finalDirectory, 'docs')),
    ).rejects.toThrow();
  });

  it('fails before creating a final directory when the only requested file is absent', async () => {
    const root = await makeTemporaryDirectory();
    const zipPath = path.join(root, 'only-missing.zip');
    const zip = new AdmZip();
    zip.addFile('project-main/other.txt', Buffer.from('other'));
    zip.writeZip(zipPath);

    await expect(
      extractArchive(zipPath, root, 'only-missing-result', {
        limits: DEFAULT_CONFIG.archiveLimits,
        onlyRelativePath: 'uploaded.txt',
      }),
    ).rejects.toThrow(/缺少目标文件/);
    await expect(
      fs.stat(path.join(root, 'only-missing-result')),
    ).rejects.toThrow();
  });

  it('rejects absolute, drive-letter, and parent paths', () => {
    expect(() => normalizeArchivePath('/etc/passwd')).toThrow();
    expect(() => normalizeArchivePath('C:\\Windows\\file.txt')).toThrow();
    expect(() => normalizeArchivePath('folder/../../escape')).toThrow();
    expect(() => normalizeArchivePath('folder/\0evil')).toThrow();
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-archive-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
