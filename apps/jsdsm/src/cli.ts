import { parseArgs, resolvePaths } from './args.ts';
import { copyViaPowerShell, type CopyProgress } from './copy.ts';
import { JsdsmError, errorMessage, isAbortError } from './errors.ts';
import { HELP_TEXT } from './help.ts';
import { VERSION } from './version.ts';
import {
  PowerShellWriter,
  defaultWriterHelperPath,
  type WriterLike,
} from './writer.ts';

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  version?: string;
  signal?: AbortSignal;
  writer?: WriterLike;
  helperPath?: string;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(
  argv: readonly string[],
  io: CliIO = defaultIO,
  options: RunCliOptions = {},
): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.kind === 'help') {
    io.stdout(HELP_TEXT.endsWith('\n') ? HELP_TEXT : `${HELP_TEXT}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    io.stdout(`${options.version ?? VERSION}\n`);
    return 0;
  }
  if (parsed.kind === 'usage-error') {
    io.stderr(`用法错误：${parsed.message}\n运行 "jsdsm --help" 查看用法。\n`);
    return 2;
  }

  const paths = resolvePaths(
    parsed.source,
    parsed.output,
    options.cwd ?? process.cwd(),
  );
  const writer =
    options.writer ??
    new PowerShellWriter({
      helperPath: options.helperPath ?? defaultWriterHelperPath(),
      configuredPath: parsed.writerPath,
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
      timeoutMs: parsed.timeoutMs,
    });

  try {
    const result = await copyViaPowerShell(
      paths.sourcePath,
      paths.outputDirectory,
      {
        writer,
        signal: options.signal,
        timeoutMs: parsed.timeoutMs,
        onProgress: createProgressReporter(
          io,
          paths.sourcePath,
          paths.outputDirectory,
        ),
      },
    );

    io.stdout(`已写入：${result.targetPath}（${result.bytes} 字节）\n`);
    return 0;
  } catch (error) {
    if (
      isAbortError(error) ||
      (error instanceof JsdsmError && error.code === 'CANCELLED')
    ) {
      io.stderr('已取消\n');
      return 1;
    }
    if (error instanceof JsdsmError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    io.stderr(`操作失败：${errorMessage(error)}\n`);
    return 1;
  }
}

function createProgressReporter(
  io: CliIO,
  sourcePath: string,
  outputDirectory: string,
): (progress: CopyProgress) => void {
  let lastBytes = 0;
  return (progress) => {
    switch (progress.phase) {
      case 'reading':
        io.stderr(`正在读取：${sourcePath}\n`);
        break;
      case 'writing':
        io.stderr(`正在写入：${outputDirectory}\n`);
        break;
      case 'progress':
        if (progress.bytes > lastBytes) {
          lastBytes = progress.bytes;
          io.stderr(`已处理 ${formatBytes(progress.bytes)}\n`);
        }
        break;
      case 'verifying':
        io.stderr('正在校验写入结果…\n');
        break;
    }
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
