import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  EMPTY_PRESET,
  createConfigFromPreset,
  parsePresetConfig,
} from '@dsm/core';

describe('preset configuration', () => {
  it('parses and normalizes the four preset fields', () => {
    expect(
      parsePresetConfig({
        gitlabUrl: ' https://gitlab.example.com/ ',
        projectId: ' group/project ',
        branch: ' release ',
        token: ' glpat-preset ',
      }),
    ).toEqual({
      gitlabUrl: 'https://gitlab.example.com',
      projectId: 'group/project',
      branch: 'release',
      token: 'glpat-preset',
    });
  });

  it('treats missing fields as empty values', () => {
    expect(parsePresetConfig({})).toEqual(EMPTY_PRESET);
  });

  it('rejects invalid preset values', () => {
    expect(() => parsePresetConfig(null)).toThrow(/JSON 对象/);
    expect(() =>
      parsePresetConfig({ gitlabUrl: 'ftp://gitlab.example.com' }),
    ).toThrow(/HTTP/);
    expect(() =>
      parsePresetConfig({ gitlabUrl: 'https://gitlab.example.com/api/v4' }),
    ).toThrow(/api\/v4/i);
    expect(() => parsePresetConfig({ projectId: 'group project' })).toThrow(
      /项目 ID/,
    );
    expect(() => parsePresetConfig({ branch: 'release 1' })).toThrow(/空白/);
    expect(() => parsePresetConfig({ token: 123 })).toThrow(/Token/);
  });

  it('builds the first-run config from preset values and defaults', () => {
    const config = createConfigFromPreset(
      parsePresetConfig({
        gitlabUrl: 'https://gitlab.example.com/',
        projectId: '42',
        branch: 'dev',
      }),
    );
    expect(config.gitlabUrl).toBe('https://gitlab.example.com');
    expect(config.projectId).toBe('42');
    expect(config.branch).toBe('dev');

    const fallback = createConfigFromPreset(parsePresetConfig({}));
    expect(fallback.gitlabUrl).toBe(DEFAULT_CONFIG.gitlabUrl);
    expect(fallback.projectId).toBe(DEFAULT_CONFIG.projectId);
    expect(fallback.branch).toBe(DEFAULT_CONFIG.branch);
  });
});
