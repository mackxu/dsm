import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
);

const distDirectory = path.join(packageRoot, 'dist');
const resourcesDirectory = path.join(distDirectory, 'resources');
const outfile = path.join(distDirectory, 'cli.js');

await rm(distDirectory, { recursive: true, force: true });
await mkdir(resourcesDirectory, { recursive: true });

// 写入代理与 local-unlock 共用同一份脚本，构建时复制，避免手工维护副本。
await copyFile(
  path.join(repositoryRoot, 'resources', 'dsm-file-writer.ps1'),
  path.join(resourcesDirectory, 'dsm-file-writer.ps1'),
);

await build({
  entryPoints: [path.join(packageRoot, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  charset: 'utf8',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    'globalThis.__JSDSM_VERSION__': JSON.stringify(packageJson.version),
  },
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
});

await chmod(outfile, 0o755);
