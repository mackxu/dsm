import type { LogLevel } from './logger.ts';
import { readerLabel, type ReaderChainResult } from './reader-chain.ts';

export const STARTUP_READER_CHECK_DELAY_MS = 3_000;

export interface StartupReaderCheckDependencies {
  checkAvailability: () => Promise<ReaderChainResult>;
  isWindowAvailable: () => boolean;
  notifyFailure: () => void;
  log: (
    level: LogLevel,
    stage: string,
    message: string,
    options?: { details?: Record<string, unknown> },
  ) => Promise<void> | void;
  /** 仅测试注入，默认 3000 毫秒。 */
  delayMs?: number;
}

export interface StartupReaderCheckHandle {
  start(): void;
  cancel(): void;
}

/**
 * 启动后延迟探测读取器链。失败时通知渲染进程弹出安装提示。
 *
 * 该模块不依赖 Electron，便于单元测试；所有异常都会被吞掉，
 * 启动检查不允许影响应用启动。
 */
export async function runStartupReaderCheck(
  deps: StartupReaderCheckDependencies,
): Promise<void> {
  try {
    if (!deps.isWindowAvailable()) {
      await safeLog(deps, 'DEBUG', '启动读取器检查已跳过：主窗口不可用');
      return;
    }

    let result: ReaderChainResult;
    try {
      result = await deps.checkAvailability();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await safeLog(deps, 'WARN', '启动读取器检查失败：未找到可用的读取器', {
        error: message,
      });
      if (!deps.isWindowAvailable()) {
        await safeLog(deps, 'DEBUG', '读取器安装提示已跳过：主窗口不可用');
        return;
      }
      deps.notifyFailure();
      return;
    }

    await safeLog(
      deps,
      'INFO',
      `启动读取器检查通过：${readerLabel(result.reader.kind)}`,
      {
        readerKind: result.reader.kind,
        readerPath: result.reader.command,
        readerVersion: result.reader.version,
        readerSource: result.reader.source,
        fallbackUsed: result.fallbackUsed,
      },
    );
  } catch {
    // 启动检查失败不应影响应用启动。
  }
}

export function createStartupReaderCheck(
  deps: StartupReaderCheckDependencies,
): StartupReaderCheckHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  return {
    start(): void {
      if (started) return;
      started = true;
      timer = setTimeout(() => {
        timer = null;
        void runStartupReaderCheck(deps).catch(() => {});
      }, deps.delayMs ?? STARTUP_READER_CHECK_DELAY_MS);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = null;
    },
  };
}

async function safeLog(
  deps: StartupReaderCheckDependencies,
  level: LogLevel,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.log(level, 'APP', message, details ? { details } : undefined);
  } catch {
    // 日志写入失败不影响检查流程。
  }
}
