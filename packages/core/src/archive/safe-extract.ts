import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Open } from 'unzipper';
import type { File as ZipEntry } from 'unzipper';

import type { ArchiveLimits } from '../config.ts';
import { DsmError } from '../errors.ts';
import {
  normalizeArchivePath,
  resolveInside,
  type PathPolicyOptions,
} from './path-policy.ts';

export interface ExtractionResult {
  finalDirectory: string;
  extractedFiles: string[];
}

export interface ExtractArchiveOptions extends PathPolicyOptions {
  limits: ArchiveLimits;
  requiredRelativePath?: string;
  /**
   * 只解压该相对路径的文件。其余归档条目仍会完成路径、类型和重复检查，
   * 但不会写入磁盘，因此结果目录只保留本次上传的文件。
   */
  onlyRelativePath?: string;
}

interface EntryPlan {
  entry: ZipEntry;
  relativePath: string;
  targetPath: string;
  isDirectory: boolean;
}

function findArchiveRoot(paths: string[]): string | null {
  const nonEmpty = paths.filter(Boolean);
  if (nonEmpty.length === 0) {
    return null;
  }
  const roots = new Set(nonEmpty.map((entryPath) => entryPath.split('/')[0]));
  if (roots.size !== 1) {
    return null;
  }
  const root = nonEmpty[0].split('/')[0];
  return nonEmpty.some((entryPath) => entryPath.includes('/')) &&
    nonEmpty.every(
      (entryPath) => entryPath === root || entryPath.startsWith(`${root}/`),
    )
    ? root
    : null;
}

function stripRoot(relativePath: string, root: string | null): string | null {
  if (!root) {
    return relativePath || null;
  }
  if (relativePath === root) {
    return null;
  }
  if (!relativePath.startsWith(`${root}/`)) {
    throw new Error(`归档条目不在统一根目录中：${relativePath}`);
  }
  return relativePath.slice(root.length + 1) || null;
}

async function walkFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

export async function extractArchive(
  archivePath: string,
  destinationRoot: string,
  directoryName: string,
  options: ExtractArchiveOptions,
): Promise<ExtractionResult> {
  await fs.mkdir(destinationRoot, { recursive: true });
  const finalDirectory = path.join(destinationRoot, directoryName);
  if (await fs.stat(finalDirectory).catch(() => null)) {
    throw new DsmError(
      'EXTRACTION_FAILED',
      `目标目录已存在：${finalDirectory}`,
      'EXTRACT',
    );
  }

  const archive = await Open.file(archivePath).catch((error: unknown) => {
    throw new DsmError(
      'ARCHIVE_INVALID',
      `无法读取 ZIP：${error instanceof Error ? error.message : String(error)}`,
      'EXTRACT',
    );
  });

  if (archive.files.length > options.limits.maxEntries) {
    throw new DsmError('EXTRACTION_FAILED', '归档条目数量超过上限', 'EXTRACT');
  }

  const normalizedPaths = archive.files.map((entry) =>
    normalizeArchivePath(entry.path, options),
  );
  const root = findArchiveRoot(normalizedPaths);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(destinationRoot, `.dsm-extract-${directoryName}-`),
  );
  const seen = new Set<string>();
  const plans: EntryPlan[] = [];

  try {
    for (let index = 0; index < archive.files.length; index += 1) {
      const entry = archive.files[index];
      const relative = stripRoot(normalizedPaths[index], root);
      if (!relative) {
        continue;
      }
      const duplicateKey =
        process.platform === 'win32' || options.caseInsensitive
          ? relative.toLocaleLowerCase('en-US')
          : relative;
      if (seen.has(duplicateKey)) {
        throw new Error(`归档包含重复路径：${entry.path}`);
      }
      seen.add(duplicateKey);

      if (entry.type !== 'File' && entry.type !== 'Directory') {
        throw new Error(`归档包含不支持的类型：${entry.type}`);
      }
      plans.push({
        entry,
        relativePath: relative,
        targetPath: resolveInside(temporaryDirectory, relative),
        isDirectory: entry.type === 'Directory',
      });
    }

    let extractedBytes = 0;
    if (options.requiredRelativePath) {
      const requiredPath = normalizeArchivePath(
        options.requiredRelativePath,
        options,
      );
      if (!plans.some((plan) => !plan.isDirectory && plan.relativePath === requiredPath)) {
        throw new Error(`归档中缺少目标文件：${options.requiredRelativePath}`);
      }
    }
    const onlyPath = options.onlyRelativePath
      ? normalizeArchivePath(options.onlyRelativePath, options)
      : null;
    if (
      onlyPath &&
      !plans.some((plan) => !plan.isDirectory && plan.relativePath === onlyPath)
    ) {
      throw new Error(`归档中缺少目标文件：${options.onlyRelativePath}`);
    }

    for (const plan of plans) {
      // 上传单文件场景只写出目标文件，避免结果目录混入仓库中的其他文件。
      if (onlyPath && plan.relativePath !== onlyPath) {
        continue;
      }
      if (plan.isDirectory) {
        await fs.mkdir(plan.targetPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(plan.targetPath), { recursive: true });
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          extractedBytes += chunk.length;
          if (extractedBytes > options.limits.maxExtractedBytes) {
            callback(new Error('解压后的文件总量超过上限'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        plan.entry.stream(),
        limiter,
        createWriteStream(plan.targetPath, { flags: 'wx' }),
      );
    }

    await fs.rename(temporaryDirectory, finalDirectory);
    return {
      finalDirectory,
      extractedFiles: await walkFiles(finalDirectory),
    };
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error instanceof DsmError
      ? error
      : new DsmError(
          'EXTRACTION_FAILED',
          error instanceof Error ? error.message : String(error),
          'EXTRACT',
        );
  }
}
