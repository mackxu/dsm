import { app, BrowserWindow, dialog, session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TaskController, type TaskSnapshot } from '@dsm/core';

import { ConfigStore } from './main/config-store.ts';
import { setupIpc } from './main/ipc.ts';
import { Logger } from './main/logger.ts';
import { LoggingHttpTransport } from './main/logging-http-transport.ts';
import {
  ElectronHttpTransport,
  ElectronPlatform,
} from './main/platform/electron-platform.ts';
import { PresetStore } from './main/preset-store.ts';
import { TokenStore } from './main/token-store.ts';
import { WhitelistedFileReader } from './main/whitelisted-file-reader.ts';

let mainWindow: BrowserWindow | null = null;
let taskController: TaskController | null = null;
let forceClose = false;
let closePromptOpen = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!app.isReady()) return;
  const window = getLiveMainWindow() ?? createWindow();
  mainWindow = window;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function getLiveMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f4f6f2',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowedDevelopmentUrl =
      MAIN_WINDOW_VITE_DEV_SERVER_URL &&
      url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    const rendererRoot = pathToFileURL(
      path.join(__dirname, '../renderer'),
    ).href;
    const allowedLocalUrl = url.startsWith(rendererRoot);
    if (!allowedDevelopmentUrl && !allowedLocalUrl) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  window.on('close', (event) => {
    if (forceClose || !isTaskActive()) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: '任务正在运行',
        message: '同步任务尚未完成。',
        detail: '可以继续等待任务结束，或立即退出应用。',
        buttons: ['继续等待', '退出应用'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        closePromptOpen = false;
        if (response === 1) {
          forceClose = true;
          app.quit();
        }
      });
  });

  return window;
}

function isTaskActive(): boolean {
  const status = taskController?.getCurrentTask()?.status;
  return Boolean(
    status &&
    !['IDLE', 'SUCCESS', 'SUCCESS_WITH_WARNING', 'FAILED'].includes(status),
  );
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    const platform = new ElectronPlatform();
    const paths = platform.paths();
    const logger = new Logger(paths.logs);
    const presetPath = app.isPackaged
      ? path.join(process.resourcesPath, 'preset.json')
      : path.resolve(app.getAppPath(), '../../resources/preset.json');
    const presetStore = new PresetStore(presetPath, (error) => {
      void logger.log('WARN', 'CONFIG', '预置配置文件读取失败，已忽略', {
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
    const configStore = new ConfigStore(paths.userData, presetStore);
    const tokenStore = new TokenStore(paths.userData, presetStore);
    const readerHelperPath = app.isPackaged
      ? path.join(process.resourcesPath, 'dsm-file-reader.cjs')
      : path.resolve(app.getAppPath(), '../../resources/dsm-file-reader.cjs');
    const fileReader = new WhitelistedFileReader({
      helperPath: readerHelperPath,
      logger,
      getConfiguredNodePath: async () =>
        (await configStore.load()).nodeReaderPath,
    });
    const transport = new LoggingHttpTransport(
      new ElectronHttpTransport(),
      logger,
    );

    let previousStatus: TaskSnapshot['status'] | null = null;
    taskController = new TaskController({
      transport,
      getConfig: () => configStore.load(),
      getToken: () => tokenStore.getToken(),
      getDocumentsDirectory: () => paths.documents,
      getTemporaryDirectory: () => paths.temporary,
      readFileContent: (filePath, options) =>
        fileReader.read(filePath, options),
      onAuthenticationFailure: (status) =>
        tokenStore.handleAuthenticationFailure(status),
      onUpdate: (snapshot) => {
        const window = getLiveMainWindow();
        if (window) window.webContents.send('dsm:task-update', snapshot);
        if (snapshot.status === previousStatus) return;
        previousStatus = snapshot.status;
        void logger.log(
          snapshot.status === 'FAILED' ? 'ERROR' : 'INFO',
          snapshot.stage ?? 'TASK',
          `任务状态：${snapshot.status}`,
          {
            taskId: snapshot.taskId,
            ...(snapshot.commitId ? { commitId: snapshot.commitId } : {}),
            ...(snapshot.fileName
              ? { details: { fileName: snapshot.fileName } }
              : {}),
          },
        );
      },
    });

    mainWindow = createWindow();
    setupIpc({
      getMainWindow: () => {
        const window = getLiveMainWindow();
        if (!window) {
          throw new Error('主窗口不可用');
        }
        return window;
      },
      configStore,
      tokenStore,
      logger,
      transport,
      platform,
      taskController,
      fileReader,
      documentsDirectory: paths.documents,
      appVersion: app.getVersion(),
      platformLabel: platformLabel(),
    });

    const config = await configStore.load();
    const saveDirectory =
      config.saveDirectory ?? path.join(paths.documents, 'DSM');
    await cleanStaleTemporaryItems(saveDirectory, logger);
    await logger.log('INFO', 'APP', '应用已启动');
  })
  .catch((error: unknown) => {
    dialog.showErrorBox(
      'DSM 文件同步助手无法启动',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (!isTaskActive()) forceClose = true;
});

async function cleanStaleTemporaryItems(
  rootDirectory: string,
  logger: Logger,
): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith('.dsm-extract-') && entry.isDirectory()) {
        await fs.rm(entryPath, { recursive: true, force: true });
        await logger.log('WARN', 'CLEANUP', '已清理上次遗留的解压临时目录');
        continue;
      }
      if (
        entry.name.startsWith('.dsm-') &&
        entry.name.endsWith('.part') &&
        entry.isFile()
      ) {
        await fs.rm(entryPath, { force: true });
        await logger.log('WARN', 'CLEANUP', '已清理上次遗留的下载临时文件');
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(entryPath);
      }
    }
  }
  await visit(rootDirectory);
}

function platformLabel(): string {
  if (process.platform === 'win32') return `Windows ${process.arch}`;
  if (process.platform === 'darwin') return `macOS ${process.arch}`;
  return `${process.platform} ${process.arch}`;
}
