import { promises as fs } from 'node:fs';
import path from 'node:path';

const env = await readEnvironment(path.resolve('.env'));
const commitId = process.env.DSM_SMOKE_COMMIT_ID?.trim() ?? '';
if (!env.GITLAB_URL || !env.PROJECT_ID || !env.GIT_TOKEN || !commitId) {
  throw new Error('Missing GitLab archive test configuration');
}

const baseUrl = env.GITLAB_URL.replace(/\/+$/, '');
const projectUrl = `${baseUrl}/api/v4/projects/${encodeURIComponent(
  env.PROJECT_ID,
)}`;
const archiveUrls = {
  zip: `${projectUrl}/repository/archive.zip?sha=${encodeURIComponent(commitId)}`,
  tarGz: `${projectUrl}/repository/archive.tar.gz?sha=${encodeURIComponent(commitId)}`,
  noExtension: `${projectUrl}/repository/archive?sha=${encodeURIComponent(commitId)}`,
  zipFormat: `${projectUrl}/repository/archive?sha=${encodeURIComponent(
    commitId,
  )}&format=zip`,
};
const variants = [
  {
    label: 'zip-mode-same-origin',
    url: archiveUrls.zip,
    accept: 'application/octet-stream',
    mode: 'same-origin' as RequestMode,
  },
  {
    label: 'zip-mode-cors',
    url: archiveUrls.zip,
    accept: 'application/octet-stream',
    mode: 'cors' as RequestMode,
  },
  {
    label: 'zip-mode-no-cors',
    url: archiveUrls.zip,
    accept: 'application/octet-stream',
    mode: 'no-cors' as RequestMode,
  },
  {
    label: 'zip-no-mode',
    url: archiveUrls.zip,
    accept: 'application/octet-stream',
    mode: undefined,
  },
  {
    label: 'zip-format',
    url: archiveUrls.zipFormat,
    accept: 'application/octet-stream',
    mode: undefined,
  },
  {
    label: 'zip-no-extension',
    url: archiveUrls.noExtension,
    accept: 'application/zip',
    mode: undefined,
  },
  {
    label: 'tar-gz',
    url: archiveUrls.tarGz,
    accept: 'application/gzip',
    mode: undefined,
  },
  {
    label: 'version',
    url: `${baseUrl}/api/v4/version`,
    accept: 'application/json',
    mode: undefined,
  },
  {
    label: 'project',
    url: projectUrl,
    accept: 'application/json',
    mode: undefined,
  },
  {
    label: 'commit',
    url: `${projectUrl}/repository/commits/${encodeURIComponent(commitId)}`,
    accept: 'application/json',
    mode: undefined,
  },
];

for (const variant of variants) {
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': env.GIT_TOKEN,
  };
  if (variant.accept) headers.Accept = variant.accept;
  // Node fetch derives `Sec-Fetch-Mode` from RequestInit.mode; a header with
  // the same name is ignored by undici.
  const response = await fetch(variant.url, {
    headers,
    ...(variant.mode ? { mode: variant.mode } : {}),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json')
    ? (await response.text()).slice(0, 2_000)
    : null;
  if (!body) await response.body?.cancel().catch(() => {});
  console.log(
    JSON.stringify({
      variant: variant.label,
      status: response.status,
      contentType,
      contentLength: response.headers.get('content-length'),
      server: response.headers.get('server'),
      gitlabMeta: response.headers.get('x-gitlab-meta'),
      body,
    }),
  );
}

async function readEnvironment(
  filePath: string,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const contents = await fs.readFile(filePath, 'utf8');
  for (const originalLine of contents.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
