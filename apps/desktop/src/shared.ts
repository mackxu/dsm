import type {
  AppConfig,
  DsmErrorCode,
  ReaderKind,
  ReaderSelection,
  ReaderSource,
  RecoveryAction,
  TaskSnapshot,
  TaskStage,
  TokenStatus,
} from '@dsm/core';
import type { LogEntry, LogPage } from './main/logger';

export const READER_INSTALL_PAGE_URL =
  'https://nas.pxsemic.local:5001/sharing/6592pf9xj';

export interface ApiError {
  code: DsmErrorCode;
  message: string;
  stage: TaskStage;
  recoverable: boolean;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface LocalFileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export interface BootstrapData {
  config: AppConfig;
  resolvedSaveDirectory: string;
  token: TokenStatus;
  appVersion: string;
  platformLabel: string;
  clientBranchNamespace: string;
  baseBranch: string;
  currentTask: TaskSnapshot | null;
  recentTasks: TaskSnapshot[];
}

export interface ConnectionResult {
  username: string;
  userId: number;
  projectPath: string;
  projectId: number;
  baseBranchExists: boolean;
  defaultBranch: string | null;
}

export interface SaveSettingsResult {
  bootstrap: BootstrapData;
  connection: ConnectionResult | null;
}

export interface ReaderProbeResult {
  fileName: string;
  preferredReader: ReaderKind;
  usedReader: ReaderKind;
  fallbackUsed: boolean;
  readerPath: string;
  readerVersion: string;
  readerSource: ReaderSource;
  directSize: number;
  readerSize: number;
  directSha256: string;
  readerSha256: string;
  directHead: string;
  readerHead: string;
  identical: boolean;
}

export interface ReaderCheckResult {
  readerKind: ReaderKind;
  readerPath: string;
  readerVersion: string;
  readerSource: ReaderSource;
  fallbackUsed: boolean;
}

export interface DesktopApi {
  bootstrap(): Promise<ApiResult<BootstrapData>>;
  chooseFile(): Promise<ApiResult<LocalFileInfo | null>>;
  inspectFile(path: string): Promise<ApiResult<LocalFileInfo>>;
  chooseDirectory(): Promise<ApiResult<string | null>>;
  getPathForFile(file: File): string;
  saveSettings(
    config: AppConfig,
    token?: string,
  ): Promise<ApiResult<SaveSettingsResult>>;
  testConnection(): Promise<ApiResult<ConnectionResult>>;
  testFileReader(
    selection: ReaderSelection,
  ): Promise<ApiResult<ReaderProbeResult>>;
  recheckReader(): Promise<ApiResult<ReaderCheckResult>>;
  openReaderInstallPage(): Promise<ApiResult<void>>;
  onReaderCheckFailure(callback: () => void): () => void;
  clearToken(): Promise<ApiResult<TokenStatus>>;
  startTask(filePath: string): Promise<ApiResult<TaskSnapshot>>;
  confirmTask(
    taskId: string,
    allowOverwrite: boolean,
  ): Promise<ApiResult<TaskSnapshot>>;
  recoverTask(
    taskId: string,
    action: RecoveryAction,
  ): Promise<ApiResult<TaskSnapshot>>;
  getCurrentTask(): Promise<ApiResult<TaskSnapshot | null>>;
  openDirectory(path: string): Promise<ApiResult<void>>;
  revealPath(path: string): Promise<ApiResult<void>>;
  getLogs(
    offset?: number,
    limit?: number,
    query?: string,
  ): Promise<ApiResult<LogPage>>;
  clearLogs(): Promise<ApiResult<void>>;
  onTaskUpdate(callback: (task: TaskSnapshot) => void): () => void;
}

export type { LogEntry, LogPage };

declare global {
  interface Window {
    dsm: DesktopApi;
  }
}
