import type {
  CopyConfig,
  CopySnapshot,
  DsmErrorCode,
  ReaderCheckResult,
  ReaderProbeResult,
  ReaderSelection,
  TaskStage,
} from '@dsm/core';
import type {
  LogEntry,
  LogPage,
  WriterCheckResult,
} from '@dsm/desktop-runtime';

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
  config: CopyConfig;
  resolvedSaveDirectory: string;
  appVersion: string;
  platformLabel: string;
  currentTask: CopySnapshot | null;
}

export interface DependencyCheckResult {
  reader: ReaderCheckResult;
  writer: WriterCheckResult;
}

export interface DependencyFailure {
  reader: boolean;
  writer: boolean;
  message: string;
}

export interface WriterTestResult {
  bytes: number;
  sha256: string;
}

export interface DesktopApi {
  bootstrap(): Promise<ApiResult<BootstrapData>>;
  chooseFile(): Promise<ApiResult<LocalFileInfo | null>>;
  inspectFile(path: string): Promise<ApiResult<LocalFileInfo>>;
  chooseDirectory(): Promise<ApiResult<string | null>>;
  getPathForFile(file: File): string;
  saveSettings(config: CopyConfig): Promise<ApiResult<BootstrapData>>;
  testReader(selection: ReaderSelection): Promise<ApiResult<ReaderProbeResult>>;
  testWriter(config?: CopyConfig): Promise<ApiResult<WriterTestResult>>;
  recheckDependencies(): Promise<ApiResult<DependencyCheckResult>>;
  openReaderInstallPage(): Promise<ApiResult<void>>;
  onDependencyCheckFailure(
    callback: (failure: DependencyFailure) => void,
  ): () => void;
  startCopy(filePath: string): Promise<ApiResult<CopySnapshot>>;
  getCurrentTask(): Promise<ApiResult<CopySnapshot | null>>;
  openDirectory(path: string): Promise<ApiResult<void>>;
  revealPath(path: string): Promise<ApiResult<void>>;
  getLogs(
    offset?: number,
    limit?: number,
    query?: string,
  ): Promise<ApiResult<LogPage>>;
  clearLogs(): Promise<ApiResult<void>>;
  onTaskUpdate(callback: (task: CopySnapshot) => void): () => void;
}

export type {
  LogEntry,
  LogPage,
  ReaderCheckResult,
  ReaderProbeResult,
  WriterCheckResult,
};

declare global {
  interface Window {
    dsm: DesktopApi;
  }
}
