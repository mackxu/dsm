import { randomUUID } from 'node:crypto';

import type { HttpTransport } from '@dsm/core';

import type { Logger } from './logger.ts';

const MAX_BODY_SUMMARY_CHARS = 500;
const MAX_LOGGED_REQUEST_BODY_CHARS = 100_000;

export class LoggingHttpTransport implements HttpTransport {
  constructor(
    private readonly transport: HttpTransport,
    private readonly logger: Logger,
  ) {}

  async request(url: string, options: RequestInit = {}): Promise<Response> {
    const requestId = randomUUID();
    const method = options.method ?? 'GET';
    const safeUrl = safeRequestUrl(url);
    const startedAt = performance.now();
    const requestSummary = summarizeRequestBody(options.body);
    const requestHeaders = safeRequestHeaders(options.headers);

    await this.writeLog(
      'INFO',
      `请求 #${shortId(requestId)} ${method} ${safeUrl}${
        requestSummary ? ` · ${requestSummary}` : ''
      }`,
      {
        requestId,
        method,
        url: safeUrl,
        requestSummary,
        requestHeaders,
        mode: options.mode ?? 'default',
      },
    );

    try {
      const response = await this.transport.request(url, options);
      const responseSummary = await summarizeResponse(response);
      const responseHeaders = safeResponseHeaders(response.headers);
      const durationMs =
        Math.round((performance.now() - startedAt) * 100) / 100;
      await this.writeLog(
        response.ok ? 'INFO' : 'WARN',
        `响应 #${shortId(requestId)} ${response.status} ${
          response.statusText || ''
        } ${method} ${safeUrl} (${durationMs} ms)${
          responseSummary ? ` · ${responseSummary}` : ''
        }`,
        {
          requestId,
          method,
          url: safeUrl,
          status: response.status,
          statusText: response.statusText,
          durationMs,
          contentType: response.headers.get('content-type'),
          contentLength: response.headers.get('content-length'),
          responseSummary,
          responseHeaders,
        },
      );
      return response;
    } catch (error) {
      const durationMs =
        Math.round((performance.now() - startedAt) * 100) / 100;
      await this.writeLog(
        'ERROR',
        `请求失败 #${shortId(requestId)} ${method} ${safeUrl} (${durationMs} ms) · ${describeError(error)}`,
        {
          requestId,
          method,
          url: safeUrl,
          durationMs,
          error: describeError(error),
        },
      );
      throw error;
    }
  }

  private async writeLog(
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.logger.log(level, 'HTTP', message, { details }).catch(() => {});
  }
}

function safeRequestHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  for (const [key, value] of normalized.entries()) {
    if (/^(accept|content-type|user-agent)$/i.test(key)) {
      result[key] = value;
    }
  }
  if (normalized.has('private-token')) {
    result['private-token'] = '[REDACTED]';
  }
  return result;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    'server',
    'via',
    'x-gitlab-meta',
    'x-request-id',
    'x-runtime',
    'cf-ray',
  ]) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function safeRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (/token|authorization|secret|password/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return value.replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]');
  }
}

function summarizeRequestBody(body: RequestInit['body']): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'string') return '二进制或非文本请求体';
  if (body.length > MAX_LOGGED_REQUEST_BODY_CHARS) {
    return `<请求体已省略，共 ${body.length} 字符>`;
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    return truncate(stableJson(redactKeys(parsed)));
  } catch {
    return `<文本请求体 ${body.length} 字符>`;
  }
}

async function summarizeResponse(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLocaleLowerCase('en-US').includes('json')) {
    return null;
  }

  try {
    const text = await response.clone().text();
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    return truncate(stableJson(redactKeys(parsed)));
  } catch {
    return '<响应体无法解析>';
  }
}

function redactKeys(value: unknown, key = ''): unknown {
  if (/^(token|authorization|private-token|content)$/i.test(key)) {
    return typeof value === 'string'
      ? `<已脱敏，${value.length} 字符>`
      : '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactKeys(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactKeys(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`,
    )
    .join(',')}}`;
}

function truncate(value: string): string {
  return value.length <= MAX_BODY_SUMMARY_CHARS
    ? value
    : `${value.slice(0, MAX_BODY_SUMMARY_CHARS)}…`;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code =
    'code' in error && typeof error.code === 'string' ? ` (${error.code})` : '';
  return `${error.name}: ${error.message}${code}`;
}
