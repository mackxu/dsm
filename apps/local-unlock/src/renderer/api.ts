import type { ApiResult } from '../shared.ts';

export class UiApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'UiApiError';
  }
}

export async function unwrap<T>(promise: Promise<ApiResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new UiApiError(
      result.error.message,
      result.error.code,
      result.error.recoverable,
    );
  }
  return result.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
