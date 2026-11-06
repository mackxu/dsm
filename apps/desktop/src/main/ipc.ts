import { BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DsmError,
  GitLabClient,
  isRemoteConfigReady,
  resolveSaveDirectory,
  validateAppConfig,
  type AppConfig,
  type HttpTransport,
  type PlatformAdapter,
  type RecoveryAction,
  type TaskController,
} from '@dsm/core';

import type {
  ApiError,
  ApiResult,
  BootstrapData,
  ConnectionResult,
  LocalFileInfo,
} from '../shared.ts';
import type { ConfigStore } from './config-store.ts';
import type { Logger } from './logger.ts';
import type { TokenStore } from './token-store.ts';

export interface IpcServices {
  getMainWindow: () => BrowserWindow;
  configStore: ConfigStore;
  tokenStore: TokenStore;
  logger: Logger;
  transport: HttpTransport;
  platform: PlatformAdapter;
  taskController: TaskController;
  documentsDirectory: string;
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

  handle<BootstrapData>('dsm:save-settings', async (_event, value) => {
    const candidate = validateAppConfig(value);
    const token = await services.tokenStore.getToken();
    if (token) {
      if (!isRemoteConfigReady(candidate)) {
        throw new DsmError(
          'CONFIG_REQUIRED',
          '已配置 Token 时，必须先填写 GitLab 地址和项目 ID',
          'CONFIG',
        );
      }
      await testConnection(candidate, token, services);
    }
    await services.configStore.save(candidate, services.documentsDirectory);
    return bootstrap(services);
  });

  handle<ConnectionResult>('dsm:test-connection', async () => {
    const config = validateAppConfig(await services.configStore.load(), {
      requireRemote: true,
    });
    const token = await services.tokenStore.getToken();
    if (!token) {
      throw new DsmError('TOKEN_MISSING', '请先配置 Token', 'CONFIG', true);
    }
    return testConnection(config, token, services);
  });

  handle('dsm:save-token', async (_event, value) => {
    const token = requireString(value, 'Token').trim();
    if (!token) {
      await services.logger.log('INFO', 'CONFIG', '用户清除了 Token');
      return services.tokenStore.clear();
    }
    const config = validateAppConfig(await services.configStore.load(), {
      requireRemote: true,
    });
    const connection = await testConnection(config, token, services);
    const status = await services.tokenStore.setUserToken(token);
    await services.logger.log('INFO', 'CONFIG', 'Token 验证并保存成功', {
      details: { username: connection.username },
    });
    return status;
  });

  handle('dsm:clear-token', async () => {
    const status = await services.tokenStore.clear();
    await services.logger.log('INFO', 'CONFIG', '用户清除了 Token');
    return status;
  });

  handle('dsm:start-task', async (_event, value) => {
    const filePath = requireString(value, '文件路径');
    return services.taskController.start(filePath);
  });

  handle(
    'dsm:confirm-task',
    async (_event, taskId, allowOverwrite, allowCreateBranch) =>
      services.taskController.confirm(requireString(taskId, '任务 ID'), {
        allowOverwrite: allowOverwrite === true,
        allowCreateBranch: allowCreateBranch === true,
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
    currentTask: services.taskController.getCurrentTask(),
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
  const client = GitLabClient.fromConfig(config, token, services.transport);
  const result = await client.testConnection();
  await services.logger.log('INFO', 'CONFIG', 'GitLab 连接验证成功', {
    details: { projectPath: result.project.path_with_namespace },
  });
  return {
    username: result.user.username,
    userId: result.user.id,
    projectPath: result.project.path_with_namespace,
    projectId: result.project.id,
    branchExists: Boolean(result.branch),
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
