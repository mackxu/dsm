import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  screen,
  session,
  shell,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACTIVE_COPY_STATUSES,
  CopyController,
  resolveSaveDirectory,
  type CopySnapshot,
} from '@dsm/core';
import {
  fitWindowToWorkArea,
  Logger,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  PowerShellWriter,
  readerLabel,
  WhitelistedFileReader,
} from '@dsm/desktop-runtime';

import { CopyConfigStore } from './main/copy-config-store.ts';
import { setupIpc } from './main/ipc.ts';
import {
  createStartupDependencyCheck,
  type StartupDependencyCheckHandle,
} from './main/startup-dependency-check.ts';
import type { DependencyFailure } from './shared.ts';

let mainWindow: BrowserWindow | null = null;
let copyController: CopyController | null = null;
let startupCheck: StartupDependencyCheckHandle | null = null;
let forceClose = false;
let closePromptOpen = false;
let isQuitting = false;

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

function resolveResourcesDirectory(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.resolve(app.getAppPath(), '../../resources');
}

let cachedAppIcon: Electron.NativeImage | null | undefined;

function getAppIcon(): Electron.NativeImage | null {
  if (cachedAppIcon === undefined) {
    const icon = nativeImage.createFromPath(
      path.join(resolveResourcesDirectory(), 'icon.png'),
    );
    cachedAppIcon = icon.isEmpty() ? null : icon;
  }
  return cachedAppIcon;
}

function createWindow(): BrowserWindow {
  const windowSize = fitWindowToWorkArea(
    screen.getPrimaryDisplay().workAreaSize,
  );
  const appIcon = getAppIcon();
  const window = new BrowserWindow({
    ...windowSize,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    ...(appIcon ? { icon: appIcon } : {}),
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
        message: '解锁任务尚未完成。',
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
  const status = copyController?.getCurrentTask()?.status;
  return Boolean(status && ACTIVE_COPY_STATUSES.has(status));
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );

    // 开发模式下 Dock 显示的是 Electron 默认图标，需要手动替换。
    if (!app.isPackaged && process.platform === 'darwin') {
      const appIcon = getAppIcon();
      if (appIcon) app.dock?.setIcon(appIcon);
    }

    const userDataDirectory = app.getPath('userData');
    const documentsDirectory = app.getPath('documents');
    const logger = new Logger(path.join(userDataDirectory, 'logs'));
    const resourcesDirectory = resolveResourcesDirectory();
    const configStore = new CopyConfigStore(userDataDirectory);
    const fileReader = new WhitelistedFileReader({
      nodeHelperPath: path.join(resourcesDirectory, 'dsm-file-reader.cjs'),
      pythonHelperPath: path.join(resourcesDirectory, 'dsm-file-reader.py'),
      logger,
      getReaderSelection: async () => {
        const config = await configStore.load();
        return {
          preferredReader: config.preferredReader,
          nodeReaderPath: config.nodeReaderPath,
          pythonReaderPath: config.pythonReaderPath,
        };
      },
    });
    const powerShellWriter = new PowerShellWriter({
      helperPath: path.join(resourcesDirectory, 'dsm-file-writer.ps1'),
      logger,
      getConfiguredPath: async () => (await configStore.load()).powershellPath,
    });

    let previousStatus: CopySnapshot['status'] | null = null;
    copyController = new CopyController({
      getConfig: () => configStore.load(),
      getDocumentsDirectory: () => documentsDirectory,
      openReadStream: (filePath, options) =>
        fileReader.openStream(filePath, options),
      openWriteSession: (targetDirectory, fileName, tempName, options) =>
        powerShellWriter.open(targetDirectory, fileName, tempName, options),
      onUpdate: (snapshot) => {
        const window = getLiveMainWindow();
        if (window) window.webContents.send('local:task-update', snapshot);
        if (snapshot.status === previousStatus) return;
        previousStatus = snapshot.status;
        const details = {
          fileName: snapshot.fileName,
          sourcePath: snapshot.sourcePath,
          targetDirectory: snapshot.targetDirectory,
          targetPath: snapshot.targetPath,
          bytesProcessed: snapshot.bytesProcessed,
          bytesRead: snapshot.bytesRead,
          bytesWritten: snapshot.bytesWritten,
          ...(snapshot.failure
            ? {
                failure: {
                  code: snapshot.failure.code,
                  stage: snapshot.failure.stage,
                  message: snapshot.failure.message,
                  recoverable: snapshot.failure.recoverable,
                },
              }
            : {}),
        };
        void logger.log(
          snapshot.status === 'FAILED' ? 'ERROR' : 'INFO',
          snapshot.stage ?? 'COPY',
          `任务状态：${snapshot.status}`,
          { taskId: snapshot.taskId, details },
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
      logger,
      copyController,
      fileReader,
      powerShellWriter,
      documentsDirectory,
      appVersion: app.getVersion(),
      platformLabel: platformLabel(),
      revealInFileManager: (targetPath) => shell.showItemInFolder(targetPath),
    });

    if (hasSingleInstanceLock) {
      startupCheck = createStartupDependencyCheck({
        checkReader: async () => {
          const { reader, fallbackUsed } = await fileReader.checkAvailability();
          await logger.log(
            'INFO',
            'APP',
            `读取器检查通过：${readerLabel(reader.kind)}`,
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
        },
        checkWriter: () => powerShellWriter.checkAvailability(),
        isWindowAvailable: () => !isQuitting && getLiveMainWindow() !== null,
        notifyFailure: (failure) => sendDependencyCheckFailure(failure),
        log: (level, stage, message, options) =>
          logger.log(level, stage, message, options),
      });
      startupCheck.start();
    }

    const config = await configStore.load();
    const saveDirectory = resolveSaveDirectory(config, documentsDirectory);
    await cleanStaleTemporaryItems(saveDirectory, logger);
    await logger.log(
      'INFO',
      'APP',
      `应用已启动：v${app.getVersion()} (${platformLabel()})`,
      {
        details: {
          resourcesDirectory,
          saveDirectory,
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
        },
      },
    );
  })
  .catch((error: unknown) => {
    dialog.showErrorBox(
      'DSM UNLOCK 无法启动',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  startupCheck?.cancel();
  copyController?.abort();
  if (!isTaskActive()) forceClose = true;
});

function sendDependencyCheckFailure(failure: DependencyFailure): void {
  const window = getLiveMainWindow();
  if (!window || window.isDestroyed()) return;
  const send = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('local:dependency-check-failed', failure);
    }
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

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
      if (
        entry.isFile() &&
        entry.name.startsWith('.dsm-copy-') &&
        entry.name.endsWith('.part')
      ) {
        await fs.rm(entryPath, { force: true }).catch(() => {});
        await logger.log('WARN', 'CLEANUP', '已清理上次遗留的写入临时文件');
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
