import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeCandidates } from '@dsm/desktop-runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-node-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

describe('nodeCandidates', () => {
  it('detects fnm, Volta, standard installs, and quoted PATH entries on Windows', async () => {
    const root = await makeTemporaryDirectory();
    const appData = path.join(root, 'appdata');
    const localAppData = path.join(root, 'local');
    const programFiles = path.join(root, 'program');
    const programFilesX86 = path.join(root, 'program86');
    const tools = path.join(root, 'tools');
    const quoted = path.join(root, 'quoted tools');
    const multishell = path.join(root, 'multishell');
    const fnmDir = path.join(appData, 'fnm');
    const versionsDirectory = path.join(fnmDir, 'node-versions');

    await makeDirectory(
      path.join(versionsDirectory, 'v20.11.0', 'installation'),
    );
    await makeDirectory(
      path.join(versionsDirectory, 'v22.13.0', 'installation'),
    );
    await makeDirectory(
      path.join(versionsDirectory, 'not-a-version', 'installation'),
    );
    await makeDirectory(path.join(fnmDir, 'aliases', 'default'));

    const result = await nodeCandidates({
      platform: 'win32',
      home: path.join(root, 'home'),
      env: {
        PATH: `"${quoted}";${tools}`,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        FNM_MULTISHELL_PATH: multishell,
        ProgramFiles: programFiles,
        'ProgramFiles(x86)': programFilesX86,
      },
    });

    expect(result).toContain(path.join(quoted, 'node.exe'));
    expect(result).toContain(path.join(tools, 'node.exe'));
    expect(result).toContain(path.join(multishell, 'node.exe'));
    expect(result).toContain(
      path.join(fnmDir, 'aliases', 'default', 'node.exe'),
    );

    const node20 = path.join(
      versionsDirectory,
      'v20.11.0',
      'installation',
      'node.exe',
    );
    const node22 = path.join(
      versionsDirectory,
      'v22.13.0',
      'installation',
      'node.exe',
    );
    expect(result).toContain(node22);
    expect(result).toContain(node20);
    expect(result.indexOf(node22)).toBeLessThan(result.indexOf(node20));
    expect(result.some((value) => value.includes('not-a-version'))).toBe(false);

    expect(result).toContain(
      path.join(localAppData, 'Volta', 'bin', 'node.exe'),
    );
    expect(result).toContain(path.join(programFiles, 'nodejs', 'node.exe'));
    expect(result).toContain(path.join(programFilesX86, 'nodejs', 'node.exe'));
    expect(result).toContain(
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
    );
    expect(result).toContain(path.join(appData, 'nvm', 'node.exe'));

    expect(result.indexOf(path.join(tools, 'node.exe'))).toBeLessThan(
      result.indexOf(node22),
    );
  });

  it('honors FNM_DIR and sees Volta on non-Windows platforms', async () => {
    const root = await makeTemporaryDirectory();
    const fnmDir = path.join(root, 'custom-fnm');
    const versionsDirectory = path.join(fnmDir, 'node-versions');
    await makeDirectory(
      path.join(versionsDirectory, 'v21.7.3', 'installation'),
    );

    const result = await nodeCandidates({
      platform: 'darwin',
      home: path.join(root, 'home'),
      env: { PATH: '/usr/bin', FNM_DIR: fnmDir },
    });

    expect(result).toContain(
      path.join(fnmDir, 'aliases', 'default', 'bin', 'node'),
    );
    expect(result).toContain(
      path.join(versionsDirectory, 'v21.7.3', 'installation', 'bin', 'node'),
    );
    expect(result).toContain(path.join(root, 'home', '.volta', 'bin', 'node'));
    expect(result).toContain('/opt/homebrew/bin/node');
    expect(result).toContain('/usr/bin/node');
  });

  it('uses the default fnm directory when FNM_DIR is unset', async () => {
    const home = await makeTemporaryDirectory();
    const fnmDir = path.join(home, 'Library', 'Application Support', 'fnm');
    const versionsDirectory = path.join(fnmDir, 'node-versions');
    await makeDirectory(
      path.join(versionsDirectory, 'v18.19.0', 'installation'),
    );

    const result = await nodeCandidates({
      platform: 'darwin',
      home,
      env: { PATH: '' },
    });

    expect(result).toContain(
      path.join(versionsDirectory, 'v18.19.0', 'installation', 'bin', 'node'),
    );
  });
});
