import { describe, expect, it } from 'vitest';

import {
  applyAuthenticationFailure,
  resolveTokenRecord,
  userTokenRecord,
  type TokenRecord,
} from '@dsm/core';

describe('token precedence', () => {
  it('imports a preset token when no user record exists', () => {
    const result = resolveTokenRecord(null, 'glpat-preset');
    expect(result.token).toBe('glpat-preset');
    expect(result.status.source).toBe('preset');
  });

  it('never restores a preset after the user clears the token', () => {
    const cleared: TokenRecord = {
      ...userTokenRecord(''),
      source: 'user',
    };
    const result = resolveTokenRecord(cleared, 'glpat-preset');
    expect(result.token).toBe('');
    expect(result.status.configured).toBe(false);
    expect(result.status.source).toBe('user');
  });

  it('preserves an existing preset token when the package file becomes empty', () => {
    const existing: TokenRecord = {
      schemaVersion: 1,
      token: 'glpat-existing',
      source: 'preset',
      updatedAt: '2026-11-05T00:00:00.000Z',
    };
    expect(resolveTokenRecord(existing, '').token).toBe('glpat-existing');
  });

  it('clears only on 401 and keeps the token on 403', () => {
    const record = userTokenRecord('glpat-user');
    expect(applyAuthenticationFailure(record, 403)).toEqual(record);
    expect(applyAuthenticationFailure(record, 401)?.token).toBe('');
  });
});
