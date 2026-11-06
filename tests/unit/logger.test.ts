import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Logger } from '../../apps/desktop/src/main/logger.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('plain-text logger', () => {
  it('writes searchable plain text and preserves structured fields', async () => {
    const directory = await temporaryDirectory();
    const logger = new Logger(directory);
    await logger.log('INFO', 'HTTP', '响应 GET /api/v4/user · {"id":3}', {
      details: {
        requestId: 'request-123',
        status: 200,
        responseSummary: '{"username":"tester"}',
      },
    });

    const raw = await readOnlyLog(directory);
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[INFO\] \[HTTP\] 响应 GET/);
    expect(raw.startsWith('{')).toBe(false);

    const result = await logger.list(0, 100, 'tester');
    expect(result.total).toBe(1);
    expect(result.entries[0].stage).toBe('HTTP');
    expect(result.entries[0].details?.status).toBe(200);
  });

  it('redacts tokens and uploaded content', async () => {
    const directory = await temporaryDirectory();
    const logger = new Logger(directory);
    await logger.log(
      'ERROR',
      'HTTP',
      '请求失败 private-token=glpat-super-secret',
      {
        details: {
          requestSummary: {
            branch: 'main',
            content: 'sensitive-base64-content',
          },
        },
      },
    );

    const raw = await readOnlyLog(directory);
    expect(raw).not.toContain('glpat-super-secret');
    expect(raw).not.toContain('sensitive-base64-content');
    expect(raw).toContain('[REDACTED]');
  });

  it('reads legacy JSON log lines during migration', async () => {
    const directory = await temporaryDirectory();
    const logger = new Logger(directory);
    await fs.writeFile(
      path.join(directory, 'dsm-2026-11-05.log'),
      `${JSON.stringify({
        time: '2026-11-05T00:00:00.000Z',
        level: 'INFO',
        stage: 'APP',
        message: 'legacy entry',
      })}\n`,
    );

    const result = await logger.list(0, 100, 'legacy');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('legacy entry');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsm-log-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function readOnlyLog(directory: string): Promise<string> {
  const files = (await fs.readdir(directory)).filter((name) =>
    name.endsWith('.log'),
  );
  return fs.readFile(path.join(directory, files[0]), 'utf8');
}
