import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isSupportedPythonVersion,
  pythonCandidates,
} from '../../apps/desktop/src/main/python-path.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-python-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

describe('isSupportedPythonVersion', () => {
  it('accepts Python 3.8 and newer', () => {
    expect(isSupportedPythonVersion('3.8.0')).toBe(true);
    expect(isSupportedPythonVersion('3.14.5')).toBe(true);
  });

  it('rejects older or malformed versions', () => {
    expect(isSupportedPythonVersion('2.7.18')).toBe(false);
    expect(isSupportedPythonVersion('3.7.17')).toBe(false);
    expect(isSupportedPythonVersion('not-a-version')).toBe(false);
  });
});

describe('pythonCandidates', () => {
  it('filters Windows Store aliases and sorts installed versions', async () => {
    const root = await makeTemporaryDirectory();
    const localAppData = path.join(root, 'local');
    const programFiles = path.join(root, 'program');
    const windowsApps = path.join(root, 'Microsoft', 'WindowsApps');
    const tools = path.join(root, 'tools');

    await makeDirectory(
      path.join(localAppData, 'Programs', 'Python', 'Python310'),
    );
    await makeDirectory(
      path.join(localAppData, 'Programs', 'Python', 'Python312'),
    );
    await makeDirectory(path.join(programFiles, 'Python313'));

    const result = await pythonCandidates({
      platform: 'win32',
      home: path.join(root, 'home'),
      env: {
        PATH: `${windowsApps};${tools}`,
        LOCALAPPDATA: localAppData,
        ProgramFiles: programFiles,
        USERPROFILE: path.join(root, 'user'),
      },
    });

    const python312 = path.join(
      localAppData,
      'Programs',
      'Python',
      'Python312',
      'python.exe',
    );
    const python310 = path.join(
      localAppData,
      'Programs',
      'Python',
      'Python310',
      'python.exe',
    );

    expect(result).toContain(python312);
    expect(result).toContain(python310);
    expect(result).toContain(
      path.join(programFiles, 'Python313', 'python.exe'),
    );
    expect(result).toContain(path.join(tools, 'python.exe'));
    expect(result).not.toContain(path.join(tools, 'py.exe'));
    expect(result.indexOf(path.join(tools, 'python.exe'))).toBeLessThan(
      result.indexOf(path.join(tools, 'python3.exe')),
    );
    expect(
      result.some((value) => value.toLowerCase().includes('windowsapps')),
    ).toBe(false);
    expect(result.indexOf(python312)).toBeLessThan(result.indexOf(python310));
  });

  it('prefers python over python3 across all PATH directories', async () => {
    const root = await makeTemporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');

    const result = await pythonCandidates({
      platform: 'linux',
      home: path.join(root, 'home'),
      env: { PATH: `${first}:${second}` },
    });

    expect(result.indexOf(path.join(second, 'python'))).toBeLessThan(
      result.indexOf(path.join(first, 'python3')),
    );
  });

  it('excludes the macOS /usr/bin stub and pyenv shims', async () => {
    const home = await makeTemporaryDirectory();
    const pyenvVersions = path.join(home, '.pyenv', 'versions');
    await makeDirectory(path.join(pyenvVersions, '3.9.18', 'bin'));
    await makeDirectory(path.join(pyenvVersions, '3.12.0', 'bin'));
    const shims = path.join(home, '.pyenv', 'shims');

    const result = await pythonCandidates({
      platform: 'darwin',
      home,
      env: {
        PATH: ['/opt/homebrew/bin', '/usr/bin', shims].join(':'),
      },
    });

    expect(result).toContain('/opt/homebrew/bin/python');
    expect(result).toContain('/opt/homebrew/bin/python3');
    expect(result.indexOf('/opt/homebrew/bin/python')).toBeLessThan(
      result.indexOf('/opt/homebrew/bin/python3'),
    );
    expect(result).toContain(
      '/Library/Developer/CommandLineTools/usr/bin/python3',
    );
    expect(result).not.toContain('/usr/bin/python3');
    expect(result).not.toContain(path.join(shims, 'python3'));
    expect(result).toContain(
      path.join(pyenvVersions, '3.12.0', 'bin', 'python'),
    );
    expect(result).toContain(
      path.join(pyenvVersions, '3.12.0', 'bin', 'python3'),
    );
    expect(
      result.indexOf(path.join(pyenvVersions, '3.12.0', 'bin', 'python')),
    ).toBeLessThan(
      result.indexOf(path.join(pyenvVersions, '3.12.0', 'bin', 'python3')),
    );
    expect(result).toContain(
      path.join(pyenvVersions, '3.9.18', 'bin', 'python3'),
    );

    const index312 = result.indexOf(
      path.join(pyenvVersions, '3.12.0', 'bin', 'python3'),
    );
    const index39 = result.indexOf(
      path.join(pyenvVersions, '3.9.18', 'bin', 'python3'),
    );
    expect(index312).toBeLessThan(index39);
  });
});
