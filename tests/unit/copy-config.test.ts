import { describe, expect, it } from 'vitest';

import {
  COPY_LIMITS,
  createDefaultCopyConfig,
  validateCopyConfig,
} from '@dsm/core';

describe('copy config', () => {
  it('provides stable defaults', () => {
    const config = createDefaultCopyConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.saveDirectory).toBeNull();
    expect(config.preferredReader).toBe('node');
    expect(config.nodeReaderPath).toBeNull();
    expect(config.pythonReaderPath).toBeNull();
    expect(config.powershellPath).toBeNull();
    expect(config.maxCopyBytes).toBe(1024 * 1024 * 1024);
    expect(config.copyTimeoutMs).toBe(10 * 60 * 1000);
  });

  it('normalizes optional paths and reader selection', () => {
    const config = validateCopyConfig({
      schemaVersion: 1,
      saveDirectory: '  /tmp/save  ',
      preferredReader: 'python',
      nodeReaderPath: '  ',
      pythonReaderPath: ' /opt/python/bin/python3 ',
      powershellPath: ' C:\\Windows\\powershell.exe ',
      maxCopyBytes: 2048,
      copyTimeoutMs: 5000,
    });
    expect(config.saveDirectory).toBe('/tmp/save');
    expect(config.preferredReader).toBe('python');
    expect(config.nodeReaderPath).toBeNull();
    expect(config.pythonReaderPath).toBe('/opt/python/bin/python3');
    expect(config.powershellPath).toBe('C:\\Windows\\powershell.exe');
    expect(config.maxCopyBytes).toBe(2048);
    expect(config.copyTimeoutMs).toBe(5000);
  });

  it('rejects unsupported schema versions', () => {
    expect(() => validateCopyConfig({ schemaVersion: 2 })).toThrowError(
      '不支持的配置版本',
    );
  });

  it('rejects invalid reader selections', () => {
    expect(() =>
      validateCopyConfig({ schemaVersion: 1, preferredReader: 'ruby' }),
    ).toThrowError('默认读取方式必须是 node 或 python');
  });

  it('enforces size and timeout limits', () => {
    expect(() =>
      validateCopyConfig({ schemaVersion: 1, maxCopyBytes: 0 }),
    ).toThrowError('复制大小限制 必须是正整数');
    expect(() =>
      validateCopyConfig({
        schemaVersion: 1,
        maxCopyBytes: COPY_LIMITS.maxCopyBytes + 1,
      }),
    ).toThrowError(/不能超过/);
    expect(() =>
      validateCopyConfig({ schemaVersion: 1, copyTimeoutMs: 0 }),
    ).toThrowError('复制超时 必须是正整数');
    expect(() =>
      validateCopyConfig({
        schemaVersion: 1,
        copyTimeoutMs: COPY_LIMITS.copyTimeoutMs + 1,
      }),
    ).toThrowError(/不能超过/);
  });

  it('rejects non-object input', () => {
    expect(() => validateCopyConfig(null)).toThrowError('配置必须是 JSON 对象');
  });

  it('rejects relative save directories', () => {
    expect(() =>
      validateCopyConfig({
        schemaVersion: 1,
        saveDirectory: 'relative/save',
      }),
    ).toThrowError('保存目录必须是绝对路径');
  });
});
