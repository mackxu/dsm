import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HttpTransport } from '@dsm/core';
import { Logger } from '../../apps/desktop/src/main/logger.ts';
import { LoggingHttpTransport } from '../../apps/desktop/src/main/logging-http-transport.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('HTTP request logging', () => {
  it('logs sanitized requests, responses and returned JSON', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dsm-http-log-test-'),
    );
    temporaryDirectories.push(directory);
    const logger = new Logger(directory);
    const fakeTransport: HttpTransport = {
      request: async () =>
        new Response(
          JSON.stringify({
            id: 3,
            username: 'tester',
            access_token: 'glpat-response-secret',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    };
    const transport = new LoggingHttpTransport(fakeTransport, logger);

    const response = await transport.request(
      'https://gitlab.example.com/api/v4/projects/1/repository/files/a.txt?ref=main&private_token=glpat-query-secret',
      {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': 'glpat-header-secret',
        },
        body: JSON.stringify({
          branch: 'main',
          content: 'sensitive-base64-file-content',
          commit_message: '[dsm:test] Upload a.txt',
        }),
      },
    );

    expect(response.status).toBe(200);
    const search = await logger.list(0, 100, 'tester');
    expect(search.total).toBe(1);
    expect(search.entries[0].message).toContain('响应');
    expect(search.entries[0].message).toContain('200');

    const files = (await fs.readdir(directory)).filter((name) =>
      name.endsWith('.log'),
    );
    const raw = await fs.readFile(path.join(directory, files[0]), 'utf8');
    expect(raw).toContain('请求 #');
    expect(raw).toContain('响应 #');
    expect(raw).toContain('tester');
    expect(raw).not.toContain('glpat-header-secret');
    expect(raw).not.toContain('glpat-query-secret');
    expect(raw).not.toContain('glpat-response-secret');
    expect(raw).not.toContain('sensitive-base64-file-content');
  });
});
