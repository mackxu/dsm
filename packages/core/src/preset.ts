import {
  DEFAULT_CONFIG,
  normalizeGitLabUrl,
  validateAppConfig,
  type AppConfig,
} from './config.ts';
import { DsmError } from './errors.ts';

/**
 * 安装包构建期写入 resources/preset.json 的预置值。
 * 所有字段均可省略，缺失时按空字符串处理。
 */
export interface PresetConfig {
  gitlabUrl: string;
  projectId: string;
  branch: string;
  token: string;
}

export const EMPTY_PRESET: Readonly<PresetConfig> = Object.freeze({
  gitlabUrl: '',
  projectId: '',
  branch: '',
  token: '',
});

export function parsePresetConfig(input: unknown): PresetConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DsmError('CONFIG_INVALID', '预置配置必须是 JSON 对象', 'CONFIG');
  }

  const candidate = input as Record<string, unknown>;
  const gitlabUrl = normalizeGitLabUrl(
    stringValue(candidate.gitlabUrl, 'GitLab 地址'),
  );
  const projectId = stringValue(candidate.projectId, '项目 ID');
  const branch = stringValue(candidate.branch, '目标分支');
  const token = stringValue(candidate.token, 'Token');

  if (projectId && (/\s/.test(projectId) || projectId.startsWith('/'))) {
    throw new DsmError('CONFIG_INVALID', '预置项目 ID 格式无效', 'CONFIG');
  }
  if (branch && /\s/.test(branch)) {
    throw new DsmError('CONFIG_INVALID', '预置分支名称不能包含空白', 'CONFIG');
  }

  return { gitlabUrl, projectId, branch, token };
}

/**
 * 把预置连接配置转换为完整配置。仅在用户尚未保存 settings.json 时使用，
 * 因此这里是首启默认值，而不是对用户配置的覆盖。
 */
export function createConfigFromPreset(preset: PresetConfig): AppConfig {
  return validateAppConfig({
    ...DEFAULT_CONFIG,
    gitlabUrl: preset.gitlabUrl || DEFAULT_CONFIG.gitlabUrl,
    projectId: preset.projectId || DEFAULT_CONFIG.projectId,
    branch: preset.branch || DEFAULT_CONFIG.branch,
  });
}

function stringValue(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new DsmError(
      'CONFIG_INVALID',
      `预置配置的${field}必须是字符串`,
      'CONFIG',
    );
  }
  return value.trim();
}
