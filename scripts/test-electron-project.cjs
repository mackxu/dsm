const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app
  .whenReady()
  .then(async () => {
    const env = readEnvironment(path.resolve('.env'));
    if (!env.GITLAB_URL || !env.PROJECT_ID || !env.GIT_TOKEN) {
      throw new Error('Missing project test configuration');
    }

    const baseUrl = env.GITLAB_URL.replace(/\/+$/, '');
    const projectUrl = `${baseUrl}/api/v4/projects/${encodeURIComponent(
      env.PROJECT_ID,
    )}`;
    const tests = [
      {
        name: 'application-json',
        url: projectUrl,
        headers: {
          'PRIVATE-TOKEN': env.GIT_TOKEN,
          Accept: 'application/json',
        },
      },
      {
        name: 'accept-any',
        url: projectUrl,
        headers: {
          'PRIVATE-TOKEN': env.GIT_TOKEN,
          Accept: '*/*',
        },
      },
      {
        name: 'token-only',
        url: projectUrl,
        headers: {
          'PRIVATE-TOKEN': env.GIT_TOKEN,
        },
      },
      {
        name: 'with-content-type',
        url: projectUrl,
        headers: {
          'PRIVATE-TOKEN': env.GIT_TOKEN,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
      {
        name: 'query-token',
        url: `${projectUrl}?private_token=${encodeURIComponent(env.GIT_TOKEN)}`,
        headers: {},
      },
    ];

    for (const test of tests) {
      const response = await net.fetch(test.url, {
        method: 'GET',
        headers: test.headers,
      });
      const body = await response.text();
      console.log(
        JSON.stringify({
          name: test.name,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get('content-type'),
          bodyPrefix: body.slice(0, 300),
        }),
      );
    }
    app.exit(0);
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
