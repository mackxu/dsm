import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { AppConfig, RecoveryAction, TaskSnapshot } from '@dsm/core';
import type { DesktopApi } from './shared.ts';

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('dsm:bootstrap'),
  chooseFile: () => ipcRenderer.invoke('dsm:choose-file'),
  inspectFile: (filePath) => ipcRenderer.invoke('dsm:inspect-file', filePath),
  chooseDirectory: () => ipcRenderer.invoke('dsm:choose-directory'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  saveSettings: (config: AppConfig, token?: string) =>
    ipcRenderer.invoke('dsm:save-settings', config, token ?? ''),
  testConnection: () => ipcRenderer.invoke('dsm:test-connection'),
  testFileReader: (selection) =>
    ipcRenderer.invoke('dsm:test-file-reader', selection),
  clearToken: () => ipcRenderer.invoke('dsm:clear-token'),
  startTask: (filePath: string) =>
    ipcRenderer.invoke('dsm:start-task', filePath),
  confirmTask: (
    taskId: string,
    allowOverwrite: boolean,
    allowCreateBranch: boolean,
  ) =>
    ipcRenderer.invoke(
      'dsm:confirm-task',
      taskId,
      allowOverwrite,
      allowCreateBranch,
    ),
  recoverTask: (taskId: string, action: RecoveryAction) =>
    ipcRenderer.invoke('dsm:recover-task', taskId, action),
  getCurrentTask: () => ipcRenderer.invoke('dsm:current-task'),
  openDirectory: (targetPath: string) =>
    ipcRenderer.invoke('dsm:open-directory', targetPath),
  revealPath: (targetPath: string) =>
    ipcRenderer.invoke('dsm:reveal-path', targetPath),
  getLogs: (offset?: number, limit?: number, query?: string) =>
    ipcRenderer.invoke('dsm:logs', offset, limit, query),
  clearLogs: () => ipcRenderer.invoke('dsm:clear-logs'),
  onTaskUpdate: (callback: (task: TaskSnapshot) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      task: TaskSnapshot,
    ): void => callback(task);
    ipcRenderer.on('dsm:task-update', listener);
    return () => ipcRenderer.removeListener('dsm:task-update', listener);
  },
};

contextBridge.exposeInMainWorld('dsm', api);
