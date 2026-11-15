import path from 'node:path';

import { normalizeReaderSelection, type ReaderKind } from '../config.ts';
import { DsmError } from '../errors.ts';

export interface CopyConfig {
  schemaVersion: 1;
  saveDirectory: string | null;
  preferredReader: ReaderKind;
  nodeReaderPath: string | null;
  pythonReaderPath: string | null;
  /** 留空表示自动探测白名单中的 PowerShell。 */
  powershellPath: string | null;
  maxCopyBytes: number;
  copyTimeoutMs: number;
}

export const COPY_LIMITS = {
  maxCopyBytes: 8 * 1024 * 1024 * 1024,
  copyTimeoutMs: 60 * 60 * 1_000,
} as const;

export const DEFAULT_COPY_CONFIG: Readonly<CopyConfig> = {
  schemaVersion: 1,
  saveDirectory: null,
  preferredReader: 'node',
  nodeReaderPath: null,
  pythonReaderPath: null,
  powershellPath: null,
  maxCopyBytes: 1024 * 1024 * 1024,
  copyTimeoutMs: 10 * 60 * 1_000,
};

function positiveInteger(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DsmError('CONFIG_INVALID', `${field} 必须是正整数`, 'CONFIG');
  }
  if ((value as number) > maximum) {
    throw new DsmError(
      'CONFIG_INVALID',
      `${field} 不能超过 ${maximum}`,
      'CONFIG',
    );
  }
  return value as number;
}

function optionalPath(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim() || null;
}

export function validateCopyConfig(input: unknown): CopyConfig {
  if (!input || typeof input !== 'object') {
    throw new DsmError('CONFIG_INVALID', '配置必须是 JSON 对象', 'CONFIG');
  }

  const candidate = input as Partial<CopyConfig>;
  if (candidate.schemaVersion !== 1) {
    throw new DsmError('CONFIG_INVALID', '不支持的配置版本', 'CONFIG');
  }

  const selection = normalizeReaderSelection({
    preferredReader: candidate.preferredReader,
    nodeReaderPath: candidate.nodeReaderPath,
    pythonReaderPath: candidate.pythonReaderPath,
  });
  const saveDirectory = optionalPath(candidate.saveDirectory);
  if (saveDirectory && !path.isAbsolute(saveDirectory)) {
    throw new DsmError('CONFIG_INVALID', '保存目录必须是绝对路径', 'CONFIG');
  }

  return {
    schemaVersion: 1,
    saveDirectory,
    preferredReader: selection.preferredReader,
    nodeReaderPath: selection.nodeReaderPath,
    pythonReaderPath: selection.pythonReaderPath,
    powershellPath: optionalPath(candidate.powershellPath),
    maxCopyBytes: positiveInteger(
      candidate.maxCopyBytes ?? DEFAULT_COPY_CONFIG.maxCopyBytes,
      '复制大小限制',
      COPY_LIMITS.maxCopyBytes,
    ),
    copyTimeoutMs: positiveInteger(
      candidate.copyTimeoutMs ?? DEFAULT_COPY_CONFIG.copyTimeoutMs,
      '复制超时',
      COPY_LIMITS.copyTimeoutMs,
    ),
  };
}

export function createDefaultCopyConfig(): CopyConfig {
  return validateCopyConfig(DEFAULT_COPY_CONFIG);
}
