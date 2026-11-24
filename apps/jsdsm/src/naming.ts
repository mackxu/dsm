import path from 'node:path';

export const MAX_NAME_ATTEMPTS = 10_000;

/**
 * 生成第 attempt 次尝试的文件名。attempt=0 返回原名，之后依次追加
 * ` (1)`、` (2)`……扩展名使用 path.parse 的最后一段。
 */
export function candidateName(baseName: string, attempt: number): string {
  if (attempt === 0) {
    return baseName;
  }
  const { name, ext } = path.parse(baseName);
  return `${name} (${attempt})${ext}`;
}
