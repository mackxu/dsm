const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

app
  .whenReady()
  .then(async () => {
    const env = readEnvironment(path.resolve('.env'));
    const commitId = process.env.DSM_SMOKE_COMMIT_ID?.trim() ?? '';
    if (!env.GITLAB_URL || !env.PROJECT_ID || !env.GIT_TOKEN || !commitId) {
      throw new Error('Missing Electron archive test configuration');
    }

    const url =
      `${env.GITLAB_URL.replace(/\/+$/, '')}/api/v4/projects/` +
      `${encodeURIComponent(env.PROJECT_ID)}/repository/archive.zip` +
      `?sha=${encodeURIComponent(commitId)}`;
    const response = await nativeRequest(url, {
      'PRIVATE-TOKEN': env.GIT_TOKEN,
      Accept: 'application/octet-stream',
      'Sec-Fetch-Mode': 'navigate',
    });
    const body = Buffer.from(await response.arrayBuffer());

    console.log(
      JSON.stringify(
        {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bytes: body.length,
          isZip: body[0] === 0x50 && body[1] === 0x4b,
        },
        null,
        2,
      ),
    );
    app.exit(response.ok && body.length > 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

function readEnvironment(filePath) {
  const values = {};
  const contents = fs.readFileSync(filePath, 'utf8');
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

function nativeRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }
    request.on('response', (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }
      resolve(
        new Response(Readable.toWeb(response), {
          status: response.statusCode,
          headers,
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}
