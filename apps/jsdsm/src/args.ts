import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_TIMEOUT_SECONDS = 86_400;

export type ParseResult =
  | {
      kind: 'run';
      source: string;
      output: string | null;
      writerPath: string | null;
      timeoutMs: number;
    }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage-error'; message: string };

function usageError(message: string): ParseResult {
  return { kind: 'usage-error', message };
}

function parseTimeout(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_TIMEOUT_SECONDS
  ) {
    return null;
  }
  return seconds === 0 ? 0 : seconds * 1_000;
}

/**
 * 解析命令行参数。`--` 之后的 token 一律视为位置参数；帮助/版本选项
 * 一旦遇到立即返回。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const positionals: string[] = [];
  let output: string | null = null;
  let writerPath: string | null = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let timeoutSet = false;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (argument === '-h' || argument === '--help')) {
      return { kind: 'help' };
    }
    if (!optionsEnded && (argument === '-v' || argument === '--version')) {
      return { kind: 'version' };
    }

    if (!optionsEnded && (argument === '-o' || argument === '--out')) {
      if (output !== null) {
        return usageError('输出目录只能指定一次');
      }
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        return usageError('选项 -o/--out 缺少输出目录');
      }
      output = value;
      index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith('--out=')) {
      if (output !== null) {
        return usageError('输出目录只能指定一次');
      }
      const value = argument.slice('--out='.length);
      if (value === '') {
        return usageError('选项 --out 缺少输出目录');
      }
      output = value;
      continue;
    }

    if (
      !optionsEnded &&
      (argument === '--writer-path' || argument === '--timeout')
    ) {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        return usageError(`选项 ${argument} 缺少值`);
      }
      if (argument === '--writer-path') {
        if (writerPath !== null) {
          return usageError('选项 --writer-path 只能指定一次');
        }
        writerPath = value;
      } else {
        if (timeoutSet) {
          return usageError('选项 --timeout 只能指定一次');
        }
        const parsed = parseTimeout(value);
        if (parsed === null) {
          return usageError('选项 --timeout 需要 0–86400 之间的整数秒');
        }
        timeoutMs = parsed;
        timeoutSet = true;
      }
      index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith('--writer-path=')) {
      if (writerPath !== null) {
        return usageError('选项 --writer-path 只能指定一次');
      }
      const value = argument.slice('--writer-path='.length);
      if (value === '') {
        return usageError('选项 --writer-path 缺少值');
      }
      writerPath = value;
      continue;
    }
    if (!optionsEnded && argument.startsWith('--timeout=')) {
      if (timeoutSet) {
        return usageError('选项 --timeout 只能指定一次');
      }
      const value = argument.slice('--timeout='.length);
      if (value === '') {
        return usageError('选项 --timeout 缺少值');
      }
      const parsed = parseTimeout(value);
      if (parsed === null) {
        return usageError('选项 --timeout 需要 0–86400 之间的整数秒');
      }
      timeoutMs = parsed;
      timeoutSet = true;
      continue;
    }

    if (!optionsEnded && argument.startsWith('-') && argument !== '-') {
      return usageError(`未知选项：${argument}`);
    }

    positionals.push(argument);
  }

  if (positionals.length === 0) {
    return usageError('缺少源文件路径');
  }
  if (positionals.length > 2) {
    return usageError(`参数过多：${positionals.slice(2).join(' ')}`);
  }
  if (positionals[0] === '') {
    return usageError('源文件路径不能为空');
  }
  if (positionals.length === 2) {
    if (output !== null) {
      return usageError('输出目录指定了多次');
    }
    if (positionals[1] === '') {
      return usageError('输出目录不能为空');
    }
    output = positionals[1];
  }

  return {
    kind: 'run',
    source: positionals[0],
    output,
    writerPath,
    timeoutMs,
  };
}

export interface ResolvedPaths {
  sourcePath: string;
  outputDirectory: string;
  usedDefaultOutput: boolean;
}

export function resolvePaths(
  sourceArgument: string,
  outputArgument: string | null,
  cwd = process.cwd(),
): ResolvedPaths {
  const sourcePath = path.resolve(cwd, sourceArgument);
  const usedDefaultOutput = outputArgument === null;
  return {
    sourcePath,
    outputDirectory: usedDefaultOutput
      ? path.dirname(sourcePath)
      : path.resolve(cwd, outputArgument),
    usedDefaultOutput,
  };
}
