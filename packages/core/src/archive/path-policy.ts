import path from 'node:path';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_ILLEGAL = /[<>:"|?*\u0000-\u001f]/;

export interface PathPolicyOptions {
  windows?: boolean;
  caseInsensitive?: boolean;
}

export function normalizeArchivePath(
  entryPath: string,
  options: PathPolicyOptions = {},
): string {
  const normalized = entryPath.replaceAll('\\', '/');
  const segments = normalized.split('/');

  if (
    normalized.includes('\0') ||
    path.posix.isAbsolute(normalized) ||
    WINDOWS_ABSOLUTE.test(normalized) ||
    normalized.startsWith('//') ||
    segments.includes('..')
  ) {
    throw new Error(`拒绝不安全的归档路径：${entryPath}`);
  }

  const filtered = segments.filter((segment) => segment && segment !== '.');
  if (options.windows) {
    for (const segment of filtered) {
      if (
        WINDOWS_ILLEGAL.test(segment) ||
        WINDOWS_RESERVED.test(segment) ||
        /[. ]$/.test(segment)
      ) {
        throw new Error(`归档包含 Windows 不支持的文件名：${entryPath}`);
      }
    }
  }

  const result = filtered.join('/');
  return options.caseInsensitive ? result.toLocaleLowerCase('en-US') : result;
}

export function resolveInside(
  baseDirectory: string,
  relativePath: string,
): string {
  const target = path.resolve(baseDirectory, ...relativePath.split('/'));
  const relative = path.relative(baseDirectory, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`归档条目越出解压目录：${relativePath}`);
  }
  return target;
}
