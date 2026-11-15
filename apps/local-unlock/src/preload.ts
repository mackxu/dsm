import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { CopyConfig, CopySnapshot, ReaderSelection } from '@dsm/core';
import type { DesktopApi, DependencyFailure } from './shared.ts';

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('local:bootstrap'),
  chooseFile: () => ipcRenderer.invoke('local:choose-file'),
  inspectFile: (filePath) => ipcRenderer.invoke('local:inspect-file', filePath),
  chooseDirectory: () => ipcRenderer.invoke('local:choose-directory'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  saveSettings: (config: CopyConfig) =>
    ipcRenderer.invoke('local:save-settings', config),
  testReader: (selection: ReaderSelection) =>
    ipcRenderer.invoke('local:test-reader', selection),
  testWriter: (config?: CopyConfig) =>
    ipcRenderer.invoke('local:test-writer', config),
  recheckDependencies: () => ipcRenderer.invoke('local:recheck-dependencies'),
  openReaderInstallPage: () =>
    ipcRenderer.invoke('local:open-reader-install-page'),
  onDependencyCheckFailure: (
    callback: (failure: DependencyFailure) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      failure: DependencyFailure,
    ): void => callback(failure);
    ipcRenderer.on('local:dependency-check-failed', listener);
    return () =>
      ipcRenderer.removeListener('local:dependency-check-failed', listener);
  },
  startCopy: (filePath: string) =>
    ipcRenderer.invoke('local:start-copy', filePath),
  getCurrentTask: () => ipcRenderer.invoke('local:current-task'),
  openDirectory: (targetPath: string) =>
    ipcRenderer.invoke('local:open-directory', targetPath),
  revealPath: (targetPath: string) =>
    ipcRenderer.invoke('local:reveal-path', targetPath),
  getLogs: (offset?: number, limit?: number, query?: string) =>
    ipcRenderer.invoke('local:logs', offset, limit, query),
  clearLogs: () => ipcRenderer.invoke('local:clear-logs'),
  onTaskUpdate: (callback: (task: CopySnapshot) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      task: CopySnapshot,
    ): void => callback(task);
    ipcRenderer.on('local:task-update', listener);
    return () => ipcRenderer.removeListener('local:task-update', listener);
  },
};

contextBridge.exposeInMainWorld('dsm', api);
