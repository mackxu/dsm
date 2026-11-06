import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import AdmZip from 'adm-zip';

const env = await readEnvironment(path.resolve('.env'));
const commitId = process.env.DSM_SMOKE_COMMIT_ID?.trim() ?? '';
if (!env.GITLAB_URL || !env.PROJECT_ID || !env.GIT_TOKEN || !commitId) {
  throw new Error('Missing GitLab archive test configuration');
}

const archiveUrl = `${env.GITLAB_URL.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(
  env.PROJECT_ID,
)}/repository/archive.zip?sha=${encodeURIComponent(commitId)}`;
const response = await requestBuffer(archiveUrl, {
  'PRIVATE-TOKEN': env.GIT_TOKEN,
  Accept: 'application/octet-stream',
});

let entries: string[] = [];
let archiveError: string | null = null;
try {
  entries = new AdmZip(response.body)
    .getEntries()
    .map((entry) => entry.entryName);
} catch (error) {
  archiveError = error instanceof Error ? error.message : String(error);
}

console.log(
  JSON.stringify(
    {
      status: response.status,
      contentType: response.headers['content-type'],
      contentLength: response.body.length,
      sha256: createHash('sha256').update(response.body).digest('hex'),
      entries,
      archiveError,
    },
    null,
    2,
  ),
);

if (response.status !== 200 || archiveError || entries.length === 0) {
  process.exitCode = 1;
}

function requestBuffer(
  url: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).request(
      target,
      { method: 'GET', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
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
