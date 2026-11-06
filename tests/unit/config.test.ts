import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  PRODUCT_LIMITS,
  validateAppConfig,
} from '@dsm/core';

describe('configuration', () => {
  it('normalizes a GitLab root URL and applies product caps', () => {
    const config = validateAppConfig({
      ...DEFAULT_CONFIG,
      gitlabUrl: 'https://gitlab.example.com/',
      projectId: 'group/project',
      maxUploadBytes: PRODUCT_LIMITS.maxUploadBytes * 2,
      archiveLimits: {
        ...DEFAULT_CONFIG.archiveLimits,
        maxEntries: PRODUCT_LIMITS.maxArchiveEntries * 2,
      },
    });

    expect(config.gitlabUrl).toBe('https://gitlab.example.com');
    expect(config.maxUploadBytes).toBe(PRODUCT_LIMITS.maxUploadBytes);
    expect(config.archiveLimits.maxEntries).toBe(PRODUCT_LIMITS.maxArchiveEntries);
  });

  it('allows local settings without remote values', () => {
    const config = validateAppConfig({
      ...DEFAULT_CONFIG,
      saveDirectory: '/tmp/dsm-results',
    });
    expect(config.projectId).toBe('');
    expect(config.saveDirectory).toBe('/tmp/dsm-results');
  });

  it('normalizes the DSM reader node path', () => {
    expect(
      validateAppConfig({
        ...DEFAULT_CONFIG,
        nodeReaderPath: '  /opt/homebrew/bin/node  ',
      }).nodeReaderPath,
    ).toBe('/opt/homebrew/bin/node');
    expect(
      validateAppConfig({
        ...DEFAULT_CONFIG,
        nodeReaderPath: '   ',
      }).nodeReaderPath,
    ).toBeNull();
    expect(validateAppConfig(DEFAULT_CONFIG).nodeReaderPath).toBeNull();
  });

  it('rejects API URLs and unsupported protocols', () => {
    expect(() =>
      validateAppConfig({
        ...DEFAULT_CONFIG,
        gitlabUrl: 'https://gitlab.example.com/api/v4',
      }),
    ).toThrow(/api\/v4/i);
    expect(() =>
      validateAppConfig({
        ...DEFAULT_CONFIG,
        gitlabUrl: 'ftp://gitlab.example.com',
      }),
    ).toThrow(/HTTP/i);
  });
});
