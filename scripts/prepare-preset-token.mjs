import { promises as fs } from 'node:fs';
import path from 'node:path';

const resourcesDirectory = path.resolve('resources');
const presetPath = path.join(resourcesDirectory, 'preset-token.txt');
const presetToken = process.env.DSM_PRESET_TOKEN?.trim() ?? '';

await fs.mkdir(resourcesDirectory, { recursive: true });
await fs.writeFile(presetPath, presetToken, { mode: 0o600 });
console.log(`Prepared ${presetPath}`);
