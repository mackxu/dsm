import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ACTIVE_COPY_STATUSES,
  DsmError,
  normalizeReaderSelection,
  resolveSaveDirectory,
  validateCopyConfig,
  type CopyController,
  type ReaderSelection,
} from '@dsm/core';
import {
  type Logger,
  type PowerShellWriter,
  type WhitelistedFileReader,
} from '@dsm/desktop-runtime';

import type {
  ApiError,
  ApiResult,
  BootstrapData,
  DependencyCheckResult,
  LocalFileInfo,
  WriterTestResult,
} from '../shared.ts';
import { READER_INSTALL_PAGE_URL } from '../shared.ts';
import type { CopyConfigStore } from './copy-config-store.ts';

export interface IpcServices {
  getMainWindow: () => BrowserWindow;
  configStore: CopyConfigStore;
  logger: Logger;
  copyController: CopyController;
  fileReader: WhitelistedFileReader;
  powerShellWriter: PowerShellWriter;
  documentsDirectory: string;
  appVersion: string;
  platformLabel: string;
  revealInFileManager: (targetPath: string) => void;
}

export function setupIpc(services: IpcServices): void {
  const handle = <T>(
    channel: string,
    handler: (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => T | Promise<T>,
  ): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<T>> => {
      try {
        assertTrustedSender(event, services.getMainWindow());
        return { ok: true, data: await handler(event, ...args) };
      } catch (error) {
        return { ok: false, error: toApiError(error) };
      }
    });
  };

  handle<BootstrapData>('local:bootstrap', () => bootstrap(services));

  handle<LocalFileInfo | null>('local:choose-file', async () => {
    const result = await dialog.showOpenDialog(services.getMainWindow(), {
      title: '选择要解锁的文件',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return inspectLocalFile(result.filePaths[0], services);
  });

  handle<LocalFileInfo>('local:inspect-file', (_event, value) =>
    inspectLocalFile(requireString(value, '文件路径'), services),
  );

  handle<string | null>('local:choose-directory', async () => {
    const result = await dialog.showOpenDialog(services.getMainWindow(), {
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle<BootstrapData>('local:save-settings', async (_event, value) => {
    const candidate = validateCopyConfig(value);
    const existing = await services.configStore.load();
    const configChanged =
      JSON.stringify(existing) !== JSON.stringify(candidate);
    const current = services.copyController.getCurrentTask();
    if (configChanged && current && ACTIVE_COPY_STATUSES.has(current.status)) {
      throw new DsmError('TASK_BUSY', '任务运行期间不能修改配置', 'CONFIG');
    }

    await services.configStore.save(candidate, services.documentsDirectory);
    if (configChanged) {
      services.fileReader.reset();
      services.powerShellWriter.reset();
    }
    await services.logger.log('INFO', 'CONFIG', '设置已保存');
    return bootstrap(services);
  });

  handle('local:test-reader', async (_event, value) => {
    const selection = parseReaderSelection(value);
    const result = await dialog.showOpenDialog(services.getMainWindow(), {
      title: '选择要测试的文件',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) {
      throw new DsmError('INVALID_REQUEST', '未选择测试文件', 'CHECK');
    }
    return services.fileReader.probe(result.filePaths[0], selection);
  });

  handle<WriterTestResult>('local:test-writer', async (_event, value) => {
    const config =
      value === undefined || value === null
        ? await services.configStore.load()
        : validateCopyConfig(value);
    const saveDirectory = resolveSaveDirectory(
      config,
      services.documentsDirectory,
    );
    const result = await services.powerShellWriter.testWrite(
      saveDirectory,
      config.powershellPath,
    );
    await services.logger.log('INFO', 'WRITE', 'PowerShell 测试写入通过', {
      details: { bytes: result.bytes },
    });
    return result;
  });

  handle<DependencyCheckResult>('local:recheck-dependencies', async () => {
    const { reader, fallbackUsed } =
      await services.fileReader.checkAvailability();
    const writer = await services.powerShellWriter.checkAvailability();
    await services.logger.log('INFO', 'APP', '依赖复检通过', {
      details: {
        readerKind: reader.kind,
        readerPath: reader.command,
        readerVersion: reader.version,
        readerSource: reader.source,
        fallbackUsed,
        writerPath: writer.writerPath,
        writerVersion: writer.writerVersion,
        writerSource: writer.writerSource,
      },
    });
    return {
      reader: {
        readerKind: reader.kind,
        readerPath: reader.command,
        readerVersion: reader.version,
        readerSource: reader.source,
        fallbackUsed,
      },
      writer,
    };
  });

  handle('local:open-reader-install-page', async () => {
    const url = new URL(READER_INSTALL_PAGE_URL);
    if (url.protocol !== 'https:') {
      throw new DsmError('INVALID_REQUEST', '安装页面地址不安全', 'CHECK');
    }
    await shell.openExternal(READER_INSTALL_PAGE_URL);
    await services.logger.log('INFO', 'APP', '已打开读取器安装页面', {
      details: { url: READER_INSTALL_PAGE_URL },
    });
  });

  handle('local:start-copy', async (_event, value) => {
    const filePath = requireString(value, '文件路径');
    return services.copyController.start(filePath);
  });

  handle('local:current-task', () => services.copyController.getCurrentTask());

  handle('local:open-directory', async (_event, value) => {
    const targetPath = requireString(value, '目录路径');
    const allowed = await allowedDirectories(services);
    const resolved = path.resolve(targetPath);
    if (
      !allowed.some(
        (directory) =>
          resolved === directory ||
          resolved.startsWith(`${directory}${path.sep}`),
      )
    ) {
      throw new DsmError('INVALID_REQUEST', '不允许打开该目录', 'CHECK');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new DsmError('INVALID_REQUEST', '目标不是目录', 'CHECK');
    }
    services.revealInFileManager(resolved);
  });

  handle('local:reveal-path', async (_event, value) => {
    const targetPath = requireString(value, '路径');
    const current = services.copyController.getCurrentTask();
    const allowed = [
      ...(await allowedDirectories(services)),
      current?.targetPath,
    ].filter((item): item is string => Boolean(item));
    const resolved = path.resolve(targetPath);
    if (
      !allowed.some(
        (allowedPath) =>
          resolved === path.resolve(allowedPath) ||
          resolved.startsWith(`${path.resolve(allowedPath)}${path.sep}`),
      )
    ) {
      throw new DsmError('INVALID_REQUEST', '不允许定位该路径', 'CHECK');
    }
    services.revealInFileManager(resolved);
  });

  handle('local:logs', async (_event, offset, limit, query) => {
    const numericOffset = Number.isFinite(offset) ? Number(offset) : 0;
    const numericLimit = Number.isFinite(limit) ? Number(limit) : 100;
    const searchQuery = typeof query === 'string' ? query.slice(0, 200) : '';
    return services.logger.list(numericOffset, numericLimit, searchQuery);
  });

  handle('local:clear-logs', async () => {
    await services.logger.clear();
    await services.logger.log('INFO', 'LOGS', '日志已由用户清空');
  });
}

async function bootstrap(services: IpcServices): Promise<BootstrapData> {
  const config = await services.configStore.load();
  return {
    config,
    resolvedSaveDirectory: resolveSaveDirectory(
      config,
      services.documentsDirectory,
    ),
    appVersion: services.appVersion,
    platformLabel: services.platformLabel,
    currentTask: services.copyController.getCurrentTask(),
  };
}

async function inspectLocalFile(
  inputPath: string,
  services: IpcServices,
): Promise<LocalFileInfo> {
  const filePath = path.resolve(inputPath);
  const config = await services.configStore.load();
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new DsmError('FILE_INVALID', '请选择有效的普通文件', 'CHECK');
  }
  if (stat.size <= 0) {
    throw new DsmError('FILE_INVALID', '不能解锁空文件', 'CHECK');
  }
  if (stat.size > config.maxCopyBytes) {
    throw new DsmError('FILE_TOO_LARGE', '文件超过复制大小上限', 'CHECK');
  }
  await fs.access(filePath, fs.constants.R_OK);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function allowedDirectories(services: IpcServices): Promise<string[]> {
  const config = await services.configStore.load();
  const current = services.copyController.getCurrentTask();
  return [
    resolveSaveDirectory(config, services.documentsDirectory),
    current?.targetDirectory,
  ]
    .filter((item): item is string => Boolean(item))
    .map((item) => path.resolve(item));
}

function assertTrustedSender(
  event: Electron.IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
): void {
  if (event.sender.id !== mainWindow.webContents.id) {
    throw new DsmError('INVALID_REQUEST', '不受信任的 IPC 调用', 'CHECK');
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DsmError('INVALID_REQUEST', `${label}无效`, 'CHECK');
  }
  return value;
}

function parseReaderSelection(value: unknown): ReaderSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DsmError('INVALID_REQUEST', '读取器测试参数无效', 'CHECK');
  }
  const record = value as Record<string, unknown>;
  return normalizeReaderSelection({
    preferredReader: record.preferredReader,
    nodeReaderPath: record.nodeReaderPath,
    pythonReaderPath: record.pythonReaderPath,
  });
}

function toApiError(error: unknown): ApiError {
  if (error instanceof DsmError) {
    return {
      code: error.code,
      message: error.message,
      stage: error.stage,
      recoverable: error.recoverable,
    };
  }
  return {
    code: 'INVALID_REQUEST',
    message: error instanceof Error ? error.message : String(error),
    stage: 'CHECK',
    recoverable: false,
  };
}
