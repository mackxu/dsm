import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '@dsm/core';

import { ConfigStore } from '../../apps/desktop/src/main/config-store.ts';
import { PresetStore } from '../../apps/desktop/src/main/preset-store.ts';
import { TokenStore } from '../../apps/desktop/src/main/token-store.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function prepare(preset: Record<string, unknown> | null): Promise<{
  userDataDirectory: string;
  presetPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsm-preset-'));
  temporaryDirectories.push(root);
  const presetPath = path.join(root, 'preset.json');
  if (preset) {
    await writeFile(presetPath, JSON.stringify(preset));
  }
  return { userDataDirectory: path.join(root, 'userData'), presetPath };
}

describe('ConfigStore preset handling', () => {
  it('uses the package preset before the user saves settings', async () => {
    const { userDataDirectory, presetPath } = await prepare({
      gitlabUrl: 'https://gitlab.example.com/',
      projectId: 'group/project',
      branch: 'release',
    });
    const store = new ConfigStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );

    const config = await store.load();
    expect(config.gitlabUrl).toBe('https://gitlab.example.com');
    expect(config.projectId).toBe('group/project');
    expect(config.branch).toBe('release');
  });

  it('keeps user settings after the user saves them', async () => {
    const { userDataDirectory, presetPath } = await prepare({
      gitlabUrl: 'https://preset.example.com',
      projectId: '1',
      branch: 'preset',
    });
    const store = new ConfigStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );
    await store.load();
    await store.save(
      {
        ...DEFAULT_CONFIG,
        gitlabUrl: 'https://user.example.com',
        projectId: '2',
        branch: 'user',
      },
      userDataDirectory,
    );

    const reloaded = new ConfigStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );
    const config = await reloaded.load();
    expect(config.gitlabUrl).toBe('https://user.example.com');
    expect(config.projectId).toBe('2');
    expect(config.branch).toBe('user');
  });

  it('falls back to defaults when the preset is missing or invalid', async () => {
    const missing = await prepare(null);
    const missingStore = new ConfigStore(
      missing.userDataDirectory,
      new PresetStore(missing.presetPath),
    );
    expect((await missingStore.load()).branch).toBe(DEFAULT_CONFIG.branch);

    const invalid = await prepare({ gitlabUrl: 'ftp://gitlab.example.com' });
    const invalidStore = new ConfigStore(
      invalid.userDataDirectory,
      new PresetStore(invalid.presetPath),
    );
    expect((await invalidStore.load()).gitlabUrl).toBe(
      DEFAULT_CONFIG.gitlabUrl,
    );
  });
});

describe('TokenStore preset handling', () => {
  it('imports the preset token and records its source', async () => {
    const { userDataDirectory, presetPath } = await prepare({
      token: ' glpat-preset ',
    });
    const store = new TokenStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );

    expect(await store.getToken()).toBe('glpat-preset');
    expect((await store.getStatus()).source).toBe('preset');

    const record = JSON.parse(
      await readFile(path.join(userDataDirectory, 'token.json'), 'utf8'),
    ) as { token: string; source: string };
    expect(record.token).toBe('glpat-preset');
    expect(record.source).toBe('preset');
  });

  it('does not restore the preset after the user clears the token', async () => {
    const { userDataDirectory, presetPath } = await prepare({
      token: 'glpat-preset',
    });
    const store = new TokenStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );
    await store.setUserToken('glpat-user');
    await store.clear();

    const reloaded = new TokenStore(
      userDataDirectory,
      new PresetStore(presetPath),
    );
    expect(await reloaded.getToken()).toBe('');
    expect((await reloaded.getStatus()).source).toBe('user');
  });
});
