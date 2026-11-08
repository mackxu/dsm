import { describe, expect, it } from 'vitest';

import {
  buildTaskBranchName,
  resolveClientBranchNamespace,
  sanitizeClientBranchSegment,
} from '@dsm/core';

const VALID_BRANCH_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

describe('client branch naming', () => {
  it('builds a readable namespace from username and hostname', () => {
    expect(
      resolveClientBranchNamespace({
        username: 'zhangsan',
        hostname: 'PC01',
      }),
    ).toBe('zhangsan-pc01');
  });

  it('sanitizes spaces, dots and git-invalid characters', () => {
    expect(
      resolveClientBranchNamespace({
        username: 'John Doe',
        hostname: 'MacBook-Pro.local',
      }),
    ).toBe('john-doe-macbook-pro-local');

    const namespace = resolveClientBranchNamespace({
      username: 'a@b~c^d:e?f*g[h]\\i',
      hostname: 'host',
    });
    expect(namespace).toMatch(VALID_BRANCH_SEGMENT);
  });

  it('strips diacritics before sanitizing', () => {
    expect(sanitizeClientBranchSegment('José', 'user')).toBe('jose');
  });

  it('uses a deterministic hash for non-ascii usernames', () => {
    const first = resolveClientBranchNamespace({
      username: '张三',
      hostname: 'pc01',
    });
    const second = resolveClientBranchNamespace({
      username: '张三',
      hostname: 'pc01',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^user-[0-9a-f]{6}-pc01$/);
  });

  it('always returns a valid non-empty namespace', () => {
    for (const identity of [
      { username: '', hostname: '' },
      { username: '---', hostname: '...' },
      { username: 'a'.repeat(200), hostname: 'b'.repeat(200) },
    ]) {
      const namespace = resolveClientBranchNamespace(identity);
      expect(namespace.length).toBeGreaterThan(0);
      expect(namespace.length).toBeLessThanOrEqual(48);
      expect(namespace).toMatch(VALID_BRANCH_SEGMENT);
      expect(namespace.endsWith('-')).toBe(false);
      expect(namespace.endsWith('_')).toBe(false);
    }
  });

  it('builds the task branch under the namespace', () => {
    expect(
      buildTaskBranchName(
        'zhangsan-pc01',
        '20261108-153000-123-ab12cd',
      ),
    ).toBe('zhangsan-pc01/20261108-153000-123-ab12cd');
  });

  it('rejects an empty namespace', () => {
    expect(() =>
      buildTaskBranchName('   ', '20261108-153000-123'),
    ).toThrow(/命名空间/);
  });
});
