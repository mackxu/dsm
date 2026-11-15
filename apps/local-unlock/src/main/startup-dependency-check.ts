import type { ReaderCheckResult } from '@dsm/core';
import type { WriterCheckResult } from '@dsm/desktop-runtime';

import type { DependencyFailure } from '../shared.ts';

export const STARTUP_DEPENDENCY_CHECK_DELAY_MS = 3_000;

export interface StartupDependencyCheckDependencies {
  checkReader: () => Promise<ReaderCheckResult>;
  checkWriter: () => Promise<WriterCheckResult>;
  isWindowAvailable: () => boolean;
  notifyFailure: (failure: DependencyFailure) => void;
  log: (
    level: 'INFO' | 'WARN',
    stage: string,
    message: string,
    options?: { details?: Record<string, unknown> },
  ) => Promise<void> | void;
  /** 仅测试注入，默认 3000 毫秒。 */
  delayMs?: number;
}

export interface StartupDependencyCheckHandle {
  start(): void;
  cancel(): void;
}

/**
 * 启动后延迟探测读取器链与 PowerShell 写入器。
 *
 * 该模块不依赖 Electron；所有异常都会被吞掉，启动检查不允许影响应用启动。
 */
export async function runStartupDependencyCheck(
  deps: StartupDependencyCheckDependencies,
): Promise<void> {
  try {
    if (!deps.isWindowAvailable()) {
      await safeLog(deps, 'INFO', '启动依赖检查已跳过：主窗口不可用');
      return;
    }

    let readerFailed = false;
    let writerFailed = false;
    const messages: string[] = [];

    try {
      await deps.checkReader();
    } catch (error) {
      readerFailed = true;
      messages.push(`读取器：${errorMessage(error)}`);
    }

    try {
      await deps.checkWriter();
    } catch (error) {
      writerFailed = true;
      messages.push(`PowerShell：${errorMessage(error)}`);
    }

    if (!readerFailed && !writerFailed) {
      await safeLog(deps, 'INFO', '启动依赖检查通过：读取器与 PowerShell');
      return;
    }

    const message = messages.join('；');
    await safeLog(deps, 'WARN', `启动依赖检查失败：${message}`);
    if (!deps.isWindowAvailable()) {
      await safeLog(deps, 'INFO', '依赖安装提示已跳过：主窗口不可用');
      return;
    }
    deps.notifyFailure({ reader: readerFailed, writer: writerFailed, message });
  } catch {
    // 启动检查失败不应影响应用启动。
  }
}

export function createStartupDependencyCheck(
  deps: StartupDependencyCheckDependencies,
): StartupDependencyCheckHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  return {
    start(): void {
      if (started) return;
      started = true;
      timer = setTimeout(() => {
        timer = null;
        void runStartupDependencyCheck(deps).catch(() => {});
      }, deps.delayMs ?? STARTUP_DEPENDENCY_CHECK_DELAY_MS);
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
  deps: StartupDependencyCheckDependencies,
  level: 'INFO' | 'WARN',
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.log(level, 'APP', message, details ? { details } : undefined);
  } catch {
    // 日志写入失败不影响检查流程。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
