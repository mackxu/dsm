import { DsmError } from './errors.ts';

export interface ArchiveLimits {
  maxBytes: number;
  maxExtractedBytes: number;
  maxEntries: number;
}

export interface AppConfig {
  schemaVersion: 1;
  gitlabUrl: string;
  projectId: string;
  branch: string;
  saveDirectory: string | null;
  apiTimeoutMs: number;
  downloadTimeoutMs: number;
  maxUploadBytes: number;
  keepArchive: boolean;
  archiveLimits: ArchiveLimits;
}

export const PRODUCT_LIMITS = {
  maxUploadBytes: 50 * 1024 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExtractedBytes: 1024 * 1024 * 1024,
  maxArchiveEntries: 50_000,
} as const;

export const DEFAULT_CONFIG: Readonly<AppConfig> = {
  schemaVersion: 1,
  gitlabUrl: '',
  projectId: '',
  branch: 'main',
  saveDirectory: null,
  apiTimeoutMs: 30_000,
  downloadTimeoutMs: 120_000,
  maxUploadBytes: PRODUCT_LIMITS.maxUploadBytes,
  keepArchive: false,
  archiveLimits: {
    maxBytes: PRODUCT_LIMITS.maxArchiveBytes,
    maxExtractedBytes: PRODUCT_LIMITS.maxExtractedBytes,
    maxEntries: PRODUCT_LIMITS.maxArchiveEntries,
  },
};

interface ValidateOptions {
  requireRemote?: boolean;
}

function positiveInteger(value: unknown, field: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DsmError('CONFIG_INVALID', `${field} 必须是正整数`, 'CONFIG');
  }
  if (maximum !== undefined && (value as number) > maximum) {
    throw new DsmError(
      'CONFIG_INVALID',
      `${field} 不能超过 ${maximum}`,
      'CONFIG',
    );
  }
  return value as number;
}

export function normalizeGitLabUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DsmError('CONFIG_INVALID', 'GitLab 地址格式无效', 'CONFIG');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DsmError('CONFIG_INVALID', 'GitLab 地址仅支持 HTTP 或 HTTPS', 'CONFIG');
  }
  if (url.username || url.password) {
    throw new DsmError('CONFIG_INVALID', 'GitLab 地址不能包含用户名或密码', 'CONFIG');
  }
  if (url.pathname === '/api/v4' || url.pathname.endsWith('/api/v4/')) {
    throw new DsmError('CONFIG_INVALID', 'GitLab 地址不应包含 /api/v4', 'CONFIG');
  }

  return trimmed;
}

export function validateAppConfig(
  input: unknown,
  options: ValidateOptions = {},
): AppConfig {
  if (!input || typeof input !== 'object') {
    throw new DsmError('CONFIG_INVALID', '配置必须是 JSON 对象', 'CONFIG');
  }

  const candidate = input as Partial<AppConfig>;
  if (candidate.schemaVersion !== 1) {
    throw new DsmError('CONFIG_INVALID', '不支持的配置版本', 'CONFIG');
  }

  const gitlabUrl = normalizeGitLabUrl(String(candidate.gitlabUrl ?? ''));
  const projectId = String(candidate.projectId ?? '').trim();
  const branch = String(candidate.branch ?? '').trim();
  const saveDirectory =
    candidate.saveDirectory === null || candidate.saveDirectory === undefined
      ? null
      : String(candidate.saveDirectory).trim() || null;

  if (options.requireRemote) {
    if (!gitlabUrl) {
      throw new DsmError('CONFIG_REQUIRED', '请配置 GitLab 地址', 'CONFIG');
    }
    if (!projectId) {
      throw new DsmError('CONFIG_REQUIRED', '请配置项目 ID', 'CONFIG');
    }
    if (!branch) {
      throw new DsmError('CONFIG_REQUIRED', '请配置分支', 'CONFIG');
    }
  }
  if (projectId && (/\s/.test(projectId) || projectId.startsWith('/'))) {
    throw new DsmError('CONFIG_INVALID', '项目 ID 格式无效', 'CONFIG');
  }
  if (branch && /\s/.test(branch)) {
    throw new DsmError('CONFIG_INVALID', '分支名称不能包含空白', 'CONFIG');
  }
  if (candidate.keepArchive !== undefined && typeof candidate.keepArchive !== 'boolean') {
    throw new DsmError('CONFIG_INVALID', '保留 ZIP 必须是布尔值', 'CONFIG');
  }

  const archiveInput = candidate.archiveLimits ?? DEFAULT_CONFIG.archiveLimits;
  if (!archiveInput || typeof archiveInput !== 'object') {
    throw new DsmError('CONFIG_INVALID', '归档限制配置无效', 'CONFIG');
  }

  return {
    schemaVersion: 1,
    gitlabUrl,
    projectId,
    branch: branch || 'main',
    saveDirectory,
    apiTimeoutMs: positiveInteger(
      candidate.apiTimeoutMs ?? DEFAULT_CONFIG.apiTimeoutMs,
      'API 超时',
      10 * 60_000,
    ),
    downloadTimeoutMs: positiveInteger(
      candidate.downloadTimeoutMs ?? DEFAULT_CONFIG.downloadTimeoutMs,
      '下载超时',
      60 * 60_000,
    ),
    maxUploadBytes: Math.min(
      positiveInteger(
        candidate.maxUploadBytes ?? DEFAULT_CONFIG.maxUploadBytes,
        '上传大小限制',
      ),
      PRODUCT_LIMITS.maxUploadBytes,
    ),
    keepArchive: candidate.keepArchive ?? DEFAULT_CONFIG.keepArchive,
    archiveLimits: {
      maxBytes: Math.min(
        positiveInteger(archiveInput.maxBytes, '归档大小限制'),
        PRODUCT_LIMITS.maxArchiveBytes,
      ),
      maxExtractedBytes: Math.min(
        positiveInteger(archiveInput.maxExtractedBytes, '解压大小限制'),
        PRODUCT_LIMITS.maxExtractedBytes,
      ),
      maxEntries: Math.min(
        positiveInteger(archiveInput.maxEntries, '归档条目限制'),
        PRODUCT_LIMITS.maxArchiveEntries,
      ),
    },
  };
}

export function createDefaultConfig(): AppConfig {
  return validateAppConfig(DEFAULT_CONFIG);
}

export function resolveSaveDirectory(
  config: AppConfig,
  documentsDirectory: string,
): string {
  return config.saveDirectory ?? `${documentsDirectory}/DSM`;
}

export function isRemoteConfigReady(config: AppConfig): boolean {
  return Boolean(config.gitlabUrl && config.projectId && config.branch);
}
