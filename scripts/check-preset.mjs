import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const resourcesDirectory = path.join(repositoryRoot, 'resources');
const presetPath = path.join(resourcesDirectory, 'preset.json');

let text;
try {
  text = await fs.readFile(presetPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
  await fs.mkdir(resourcesDirectory, { recursive: true });
  await fs.writeFile(presetPath, '{}\n', { mode: 0o600 });
  await fs.chmod(presetPath, 0o600).catch(() => {});
  console.log(`Created empty ${presetPath}`);
  console.log('Preset fields: (none)');
  process.exit(0);
}

const preset = parsePreset(text);
await fs.chmod(presetPath, 0o600).catch(() => {});

const fields = Object.entries(preset)
  .filter(([, value]) => value)
  .map(([key]) => key);
console.log(`Validated ${presetPath}`);
console.log(`Preset fields: ${fields.length ? fields.join(', ') : '(none)'}`);

function parsePreset(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error(`${presetPath} 不是有效的 JSON`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${presetPath} 必须是 JSON 对象`);
  }

  return {
    gitlabUrl: normalizeGitLabUrl(stringValue(input.gitlabUrl, 'gitlabUrl')),
    projectId: normalizeProjectId(stringValue(input.projectId, 'projectId')),
    token: stringValue(input.token, 'token'),
  };
}

function stringValue(value, field) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${presetPath} 的 ${field} 必须是字符串`);
  }
  return value.trim();
}

function normalizeGitLabUrl(value) {
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${presetPath} 的 gitlabUrl 不是有效的 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${presetPath} 的 gitlabUrl 仅支持 HTTP 或 HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${presetPath} 的 gitlabUrl 不能包含用户名或密码`);
  }
  if (url.pathname === '/api/v4' || url.pathname.endsWith('/api/v4/')) {
    throw new Error(`${presetPath} 的 gitlabUrl 不应包含 /api/v4`);
  }
  return trimmed;
}

function normalizeProjectId(value) {
  if (!value) {
    return '';
  }
  if (/\s/.test(value) || value.startsWith('/')) {
    throw new Error(`${presetPath} 的 projectId 格式无效`);
  }
  return value;
}
