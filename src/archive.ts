import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Open } from 'unzipper';
import type { File as ZipEntry } from 'unzipper';

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;

export interface ExtractionResult {
  finalDirectory: string;
  extractedFiles: string[];
}

function normalizeArchivePath(entryPath: string): string {
  const normalized = entryPath.replaceAll('\\', '/');
  const segments = normalized.split('/');

  if (
    path.posix.isAbsolute(normalized) ||
    WINDOWS_ABSOLUTE_PATH.test(normalized) ||
    segments.includes('..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Unsafe archive entry rejected: ${entryPath}`);
  }

  return normalized.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function findArchiveRoot(entries: ZipEntry[]): string | null {
  const paths = entries
    .map((entry) => normalizeArchivePath(entry.path))
    .filter(Boolean);
  const firstSegments = new Set(paths.map((entryPath) => entryPath.split('/')[0]));

  if (firstSegments.size !== 1) {
    return null;
  }

  const root = paths[0]?.split('/')[0];
  const hasNestedEntry = paths.some((entryPath) => entryPath.includes('/'));
  const allEntriesAreInsideRoot =
    root &&
    paths.every((entryPath) => entryPath === root || entryPath.startsWith(`${root}/`));

  return allEntriesAreInsideRoot && hasNestedEntry ? root : null;
}

function resolveEntryPath(
  temporaryDirectory: string,
  entryPath: string,
  archiveRoot: string | null,
): string | null {
  let relativePath = entryPath;

  if (archiveRoot) {
    if (relativePath === archiveRoot) {
      return null;
    }
    relativePath = relativePath.slice(archiveRoot.length + 1);
  }

  if (!relativePath) {
    return null;
  }

  const targetPath = path.resolve(temporaryDirectory, ...relativePath.split('/'));
  const relativeToTemporary = path.relative(temporaryDirectory, targetPath);

  if (
    relativeToTemporary === '' ||
    relativeToTemporary.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToTemporary)
  ) {
    throw new Error(`Archive entry escapes extraction directory: ${entryPath}`);
  }

  return targetPath;
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function extractArchive(
  archivePath: string,
  extractBase: string,
  timestamp: string,
): Promise<ExtractionResult> {
  const finalDirectory = path.join(extractBase, timestamp);
  if (await fs.stat(finalDirectory).catch(() => null)) {
    throw new Error(`Timestamped extraction directory already exists: ${finalDirectory}`);
  }

  const archive = await Open.file(archivePath);
  const archiveRoot = findArchiveRoot(archive.files);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(extractBase, `.extract-${timestamp}-`),
  );

  try {
    for (const entry of archive.files) {
      const entryPath = normalizeArchivePath(entry.path);
      const targetPath = resolveEntryPath(
        temporaryDirectory,
        entryPath,
        archiveRoot,
      );

      if (!targetPath) {
        continue;
      }

      if (entry.type === 'Directory') {
        await fs.mkdir(targetPath, { recursive: true });
        continue;
      }

      if (entry.type !== 'File') {
        throw new Error(`Unsupported archive entry type: ${entry.type}`);
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await pipeline(
        entry.stream(),
        createWriteStream(targetPath, { flags: 'wx' }),
      );
    }

    await fs.rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const extractedFiles = await walkFiles(finalDirectory);
  return { finalDirectory, extractedFiles };
}
