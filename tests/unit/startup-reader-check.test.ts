import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReaderChainResult } from '../../apps/desktop/src/main/reader-chain.ts';
import {
  createStartupReaderCheck,
  runStartupReaderCheck,
  STARTUP_READER_CHECK_DELAY_MS,
  type StartupReaderCheckDependencies,
} from '../../apps/desktop/src/main/startup-reader-check.ts';

afterEach(() => {
  vi.useRealTimers();
});

function availableResult(): ReaderChainResult {
  return {
    reader: {
      kind: 'node',
      command: '/usr/bin/node',
      version: '22.13.0',
      source: 'auto',
    },
    fallbackUsed: false,
  };
}

function createDependencies(
  overrides: Partial<StartupReaderCheckDependencies> = {},
): {
  deps: StartupReaderCheckDependencies;
  log: ReturnType<typeof vi.fn>;
  notifyFailure: ReturnType<typeof vi.fn>;
  checkAvailability: ReturnType<typeof vi.fn>;
} {
  const log = vi.fn();
  const notifyFailure = vi.fn();
  const checkAvailability = vi.fn().mockResolvedValue(availableResult());
  const deps: StartupReaderCheckDependencies = {
    checkAvailability,
    isWindowAvailable: () => true,
    notifyFailure,
    log,
    ...overrides,
  };
  return { deps, log, notifyFailure, checkAvailability };
}

describe('runStartupReaderCheck', () => {
  it('logs success without notifying the renderer', async () => {
    const { deps, log, notifyFailure } = createDependencies();

    await runStartupReaderCheck(deps);

    expect(notifyFailure).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'INFO',
      'APP',
      '启动读取器检查通过：Node',
      {
        details: {
          readerKind: 'node',
          readerPath: '/usr/bin/node',
          readerVersion: '22.13.0',
          readerSource: 'auto',
          fallbackUsed: false,
        },
      },
    );
  });

  it('logs a warning and notifies the renderer when detection fails', async () => {
    const error = new Error('未找到可用的前置依赖');
    const { deps, log, notifyFailure } = createDependencies({
      checkAvailability: vi.fn().mockRejectedValue(error),
    });

    await runStartupReaderCheck(deps);

    expect(log).toHaveBeenCalledWith(
      'WARN',
      'APP',
      '启动读取器检查失败：未找到可用的读取器',
      { details: { error: error.message } },
    );
    expect(notifyFailure).toHaveBeenCalledTimes(1);
  });

  it('skips detection when the window is not available', async () => {
    const { deps, notifyFailure, checkAvailability } = createDependencies({
      isWindowAvailable: () => false,
    });

    await runStartupReaderCheck(deps);

    expect(checkAvailability).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it('does not notify when the window closes while detection is running', async () => {
    const isWindowAvailable = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const { deps, notifyFailure } = createDependencies({
      isWindowAvailable,
      checkAvailability: vi
        .fn()
        .mockRejectedValue(new Error('未找到可用的前置依赖')),
    });

    await runStartupReaderCheck(deps);

    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it('notifies on a non-Error rejection', async () => {
    const { deps, log, notifyFailure } = createDependencies({
      checkAvailability: vi.fn().mockRejectedValue('boom'),
    });

    await runStartupReaderCheck(deps);

    expect(log).toHaveBeenCalledWith(
      'WARN',
      'APP',
      '启动读取器检查失败：未找到可用的读取器',
      { details: { error: 'boom' } },
    );
    expect(notifyFailure).toHaveBeenCalledTimes(1);
  });

  it('does not reject when logging fails', async () => {
    const { deps } = createDependencies({
      log: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    await expect(runStartupReaderCheck(deps)).resolves.toBeUndefined();
  });
});

describe('createStartupReaderCheck', () => {
  it('waits for the default delay before running once', async () => {
    vi.useFakeTimers();
    const { deps, checkAvailability } = createDependencies();
    const handle = createStartupReaderCheck(deps);

    handle.start();
    await vi.advanceTimersByTimeAsync(STARTUP_READER_CHECK_DELAY_MS - 1);
    expect(checkAvailability).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkAvailability).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when started twice', async () => {
    vi.useFakeTimers();
    const { deps, checkAvailability } = createDependencies();
    const handle = createStartupReaderCheck(deps);

    handle.start();
    handle.start();
    await vi.advanceTimersByTimeAsync(STARTUP_READER_CHECK_DELAY_MS);

    expect(checkAvailability).toHaveBeenCalledTimes(1);
  });

  it('does not run after cancel', async () => {
    vi.useFakeTimers();
    const { deps, checkAvailability } = createDependencies();
    const handle = createStartupReaderCheck(deps);

    handle.start();
    handle.cancel();
    await vi.advanceTimersByTimeAsync(STARTUP_READER_CHECK_DELAY_MS);

    expect(checkAvailability).not.toHaveBeenCalled();
  });
});
