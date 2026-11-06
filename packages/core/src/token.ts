import { DsmError } from './errors.ts';

export type TokenSource = 'preset' | 'user';

export interface TokenRecord {
  schemaVersion: 1;
  token: string;
  source: TokenSource;
  updatedAt: string;
}

export interface TokenStatus {
  configured: boolean;
  source: TokenSource | 'none';
  updatedAt: string | null;
}

export interface ResolvedToken {
  record: TokenRecord | null;
  token: string;
  status: TokenStatus;
}

export function parseTokenRecord(input: unknown): TokenRecord {
  if (!input || typeof input !== 'object') {
    throw new DsmError('CONFIG_INVALID', 'Token 文件格式无效', 'CONFIG');
  }
  const candidate = input as Partial<TokenRecord>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.token !== 'string' ||
    (candidate.source !== 'preset' && candidate.source !== 'user') ||
    typeof candidate.updatedAt !== 'string'
  ) {
    throw new DsmError('CONFIG_INVALID', 'Token 文件格式无效', 'CONFIG');
  }
  return {
    schemaVersion: 1,
    token: candidate.token,
    source: candidate.source,
    updatedAt: candidate.updatedAt,
  };
}

export function resolveTokenRecord(
  existing: TokenRecord | null,
  presetToken: string,
): ResolvedToken {
  if (existing?.source === 'user') {
    return {
      record: existing,
      token: existing.token,
      status: tokenStatus(existing),
    };
  }

  if (existing?.source === 'preset') {
    if (presetToken.trim()) {
      const refreshed = {
        ...existing,
        token: presetToken.trim(),
      };
      return {
        record: refreshed,
        token: refreshed.token,
        status: tokenStatus(refreshed),
      };
    }
    return {
      record: existing,
      token: existing.token,
      status: tokenStatus(existing),
    };
  }

  if (presetToken.trim()) {
    const imported: TokenRecord = {
      schemaVersion: 1,
      token: presetToken.trim(),
      source: 'preset',
      updatedAt: new Date().toISOString(),
    };
    return {
      record: imported,
      token: imported.token,
      status: tokenStatus(imported),
    };
  }

  return {
    record: null,
    token: '',
    status: { configured: false, source: 'none', updatedAt: null },
  };
}

export function userTokenRecord(token: string, now = new Date()): TokenRecord {
  return {
    schemaVersion: 1,
    token,
    source: 'user',
    updatedAt: now.toISOString(),
  };
}

export function applyAuthenticationFailure(
  record: TokenRecord | null,
  status: number,
  now = new Date(),
): TokenRecord | null {
  if (status === 401) {
    return userTokenRecord('', now);
  }
  return record;
}

function tokenStatus(record: TokenRecord): TokenStatus {
  return {
    configured: record.token.length > 0,
    source: record.source,
    updatedAt: record.updatedAt,
  };
}
