import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ACTIVE_TASK_STATUSES,
  BASE_BRANCH_NAME,
  DsmError,
  GitLabClient,
  isRemoteConfigReady,
  normalizeReaderSelection,
  resolveSaveDirectory,
  validateAppConfig,
  type AppConfig,
  type HttpTransport,
  type PlatformAdapter,
  type ReaderSelection,
  type RecoveryAction,
  type TaskController,
} from '@dsm/core';

import type {
  ApiError,
  ApiResult,
  BootstrapData,
  ConnectionResult,
  LocalFileInfo,
  ReaderCheckResult,
  ReaderProbeResult,
  SaveSettingsResult,
} from '../shared.ts';
import { READER_INSTALL_PAGE_URL } from '../shared.ts';
import type { ConfigStore } from './config-store.ts';
import {
  readerLabel,
  type Logger,
  type WhitelistedFileReader,
} from '@dsm/desktop-runtime';
import type { TaskHistoryStore } from './task-history-store.ts';
import type { TokenStore } from './token-store.ts';

export interface IpcServices {
  getMainWindow: () => BrowserWindow;
  configStore: ConfigStore;
  tokenStore: TokenStore;
  logger: Logger;
  transport: HttpTransport;
  platform: PlatformAdapter;
  taskController: TaskController;
  taskHistory: TaskHistoryStore;
  fileReader: WhitelistedFileReader;
  documentsDirectory: string;
  clientBranchNamespace: string;
  appVersion: string;
  platformLabel: string;
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

  handle<BootstrapData>('dsm:bootstrap', () => bootstrap(services));

  handle<LocalFileInfo | null>('dsm:choose-file', async () => {
    const result = await dialog.showOpenDialog(services.getMainWindow(), {
      title: '选择要同步的文件',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return inspectLocalFile(result.filePaths[0], services);
  });

  handle<LocalFileInfo>('dsm:inspect-file', (_event, value) =>
    inspectLocalFile(requireString(value, '文件路径'), services),
  );

  handle<string | null>('dsm:choose-directory', async () => {
    const result = await dialog.showOpenDialog(services.getMainWindow(), {
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle<SaveSettingsResult>(
    'dsm:save-settings',
    async (_event, value, tokenValue) => {
      const candidate = validateAppConfig(value);
      const newToken = parseOptionalToken(tokenValue);

      const existing = await services.configStore.load();
      const configChanged =
        JSON.stringify(existing) !== JSON.stringify(candidate);
      const currentTask = services.taskController.getCurrentTask();
      if (
        configChanged &&
        currentTask &&
        ACTIVE_TASK_STATUSES.has(currentTask.status)
      ) {
        throw new DsmError(
          'TASK_BUSY',
          '任务运行期间不能修改连接配置',
          'CONFIG',
        );
      }

      const effectiveToken = newToken || (await services.tokenStore.getToken());
      let connection: ConnectionResult | null = null;
      if (effectiveToken) {
        if (!isRemoteConfigReady(candidate)) {
          throw new DsmError(
            'CONFIG_REQUIRED',
            '已配置访问令牌时，请先填写服务地址和项目',
            'CONFIG',
          );
        }
        connection = await testConnection(candidate, effectiveToken, services);
      }

      await services.configStore.save(candidate, services.documentsDirectory);
      if (configChanged) {
        services.fileReader.reset();
      }

      if (newToken) {
        await services.tokenStore.setUserToken(newToken);
        await services.logger.log('INFO', 'CONFIG', '访问令牌验证并保存成功', {
          details: { username: connection?.username },
        });
      }

      return { bootstrap: await bootstrap(services), connection };
    },
  );

  handle<ConnectionResult>('dsm:test-connection', async () => {
    const config = validateAppConfig(await services.configStore.load(), {
      requireRemote: true,
    });
    const token = await services.tokenStore.getToken();
    if (!token) {
      throw new DsmError('TOKEN_MISSING', '请先配置访问令牌', 'CONFIG', true);
    }
    return testConnection(config, token, services);
  });

  handle<ReaderProbeResult>('dsm:test-file-reader', async (_event, value) => {
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

  handle<ReaderCheckResult>('dsm:recheck-reader', async () => {
    const { reader, fallbackUsed } =
      await services.fileReader.checkAvailability();
    await services.logger.log(
      'INFO',
      'APP',
      `读取器复检通过：${readerLabel(reader.kind)}`,
      {
        details: {
          readerKind: reader.kind,
          readerPath: reader.command,
          readerVersion: reader.version,
          readerSource: reader.source,
          fallbackUsed,
        },
      },
    );
    return {
      readerKind: reader.kind,
      readerPath: reader.command,
      readerVersion: reader.version,
      readerSource: reader.source,
      fallbackUsed,
    };
  });

  handle('dsm:open-reader-install-page', async () => {
    const url = new URL(READER_INSTALL_PAGE_URL);
    if (url.protocol !== 'https:') {
      throw new DsmError('INVALID_REQUEST', '安装页面地址不安全', 'CHECK');
    }
    await shell.openExternal(READER_INSTALL_PAGE_URL);
    await services.logger.log('INFO', 'APP', '已打开读取器安装页面', {
      details: { url: READER_INSTALL_PAGE_URL },
    });
  });

  handle('dsm:clear-token', async () => {
    const status = await services.tokenStore.clear();
    await services.logger.log('INFO', 'CONFIG', '用户清除了访问令牌');
    return status;
  });

  handle('dsm:start-task', async (_event, value) => {
    const filePath = requireString(value, '文件路径');
    return services.taskController.start(filePath);
  });

  handle('dsm:confirm-task', async (_event, taskId, allowOverwrite) =>
    services.taskController.confirm(requireString(taskId, '任务 ID'), {
      allowOverwrite: allowOverwrite === true,
    }),
  );

  handle('dsm:recover-task', async (_event, taskId, action) =>
    services.taskController.recover(
      requireString(taskId, '任务 ID'),
      requireRecoveryAction(action),
    ),
  );

  handle('dsm:current-task', () => services.taskController.getCurrentTask());

  handle('dsm:open-directory', async (_event, value) => {
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
    await services.platform.revealInFileManager(resolved);
  });

  handle('dsm:reveal-path', async (_event, value) => {
    const targetPath = requireString(value, '路径');
    const current = services.taskController.getCurrentTask();
    const allowed = [
      ...(await allowedDirectories(services)),
      current?.resultDirectory,
      current?.archivePath,
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
    await services.platform.revealInFileManager(resolved);
  });

  handle('dsm:logs', async (_event, offset, limit, query) => {
    const numericOffset = Number.isFinite(offset) ? Number(offset) : 0;
    const numericLimit = Number.isFinite(limit) ? Number(limit) : 100;
    const searchQuery = typeof query === 'string' ? query.slice(0, 200) : '';
    return services.logger.list(numericOffset, numericLimit, searchQuery);
  });

  handle('dsm:clear-logs', async () => {
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
    token: await services.tokenStore.getStatus(),
    appVersion: services.appVersion,
    platformLabel: services.platformLabel,
    clientBranchNamespace: services.clientBranchNamespace,
    baseBranch: BASE_BRANCH_NAME,
    currentTask: services.taskController.getCurrentTask(),
    recentTasks: await services.taskHistory.list(),
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
    throw new DsmError('FILE_INVALID', '不能上传空文件', 'CHECK');
  }
  if (stat.size > config.maxUploadBytes) {
    throw new DsmError('FILE_TOO_LARGE', '文件超过上传大小上限', 'CHECK');
  }
  await fs.access(filePath, fs.constants.R_OK);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function testConnection(
  config: AppConfig,
  token: string,
  services: IpcServices,
): Promise<ConnectionResult> {
  const client = GitLabClient.fromConfig(
    config,
    token,
    services.transport,
    BASE_BRANCH_NAME,
  );
  const result = await client.testConnection();
  await services.logger.log('INFO', 'CONFIG', '连接验证成功');
  return {
    username: result.user.username,
    userId: result.user.id,
    projectPath: result.project.path_with_namespace,
    projectId: result.project.id,
    baseBranchExists: !result.project.empty_repo && Boolean(result.baseBranch),
    defaultBranch: result.project.default_branch,
  };
}

async function allowedDirectories(services: IpcServices): Promise<string[]> {
  const config = await services.configStore.load();
  const current = services.taskController.getCurrentTask();
  return [
    resolveSaveDirectory(config, services.documentsDirectory),
    current?.resultDirectory,
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

function parseOptionalToken(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new DsmError('INVALID_REQUEST', '访问令牌格式无效', 'CONFIG');
  }
  return value.trim() || null;
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

function requireRecoveryAction(value: unknown): RecoveryAction {
  const actions: RecoveryAction[] = [
    'CONFIGURE_TOKEN',
    'QUERY_COMMIT',
    'RETRY_DOWNLOAD',
    'RETRY_EXTRACTION',
    'RETRY_CLEANUP',
  ];
  if (typeof value !== 'string' || !actions.includes(value as RecoveryAction)) {
    throw new DsmError('INVALID_REQUEST', '不支持的恢复操作', 'CHECK');
  }
  return value as RecoveryAction;
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
