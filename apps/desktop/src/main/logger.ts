import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  time: string;
  level: LogLevel;
  taskId?: string;
  stage?: string;
  message: string;
  commitId?: string;
  details?: Record<string, unknown>;
}

export interface LogPage {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DETAILS_SEPARATOR = ' | ';
const TEXT_LOG_PATTERN =
  /^(\S+) \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]+)\] ([\s\S]*)$/;

export class Logger {
  constructor(private readonly logsDirectory: string) {}

  async log(
    level: LogLevel,
    stage: string,
    message: string,
    options: Omit<LogEntry, 'time' | 'level' | 'stage' | 'message'> = {},
  ): Promise<void> {
    const entry = normalizeEntry({
      time: new Date().toISOString(),
      level,
      stage,
      message,
      ...options,
    });
    await fs.mkdir(this.logsDirectory, { recursive: true });
    const filePath = this.fileForDate(new Date());
    await fs.appendFile(filePath, `${formatLogLine(entry)}\n`, {
      mode: 0o600,
    });
    await this.enforceRetention();
  }

  async list(offset = 0, limit = 100, query = ''): Promise<LogPage> {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    const entries: LogEntry[] = [];
    let total = 0;

    for (const filePath of await this.logFilesNewestFirst()) {
      const lines = (await fs.readFile(filePath, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        if (
          normalizedQuery &&
          !line.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
        ) {
          continue;
        }
        const entry = parseLogLine(line);
        if (!entry) continue;
        if (total >= safeOffset && entries.length < safeLimit) {
          entries.push(entry);
        }
        total += 1;
      }
    }

    return {
      entries,
      total,
      hasMore: safeOffset + entries.length < total,
    };
  }

  async clear(): Promise<void> {
    const directoryEntries = await fs
      .readdir(this.logsDirectory, { withFileTypes: true })
      .catch(() => []);
    await Promise.all(
      directoryEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .map((entry) =>
          fs.rm(path.join(this.logsDirectory, entry.name), { force: true }),
        ),
    );
  }

  private fileForDate(date: Date): string {
    return path.join(
      this.logsDirectory,
      `dsm-${date.toISOString().slice(0, 10)}.log`,
    );
  }

  private async logFilesNewestFirst(): Promise<string[]> {
    const entries = await fs
      .readdir(this.logsDirectory, { withFileTypes: true })
      .catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => path.join(this.logsDirectory, entry.name))
      .sort((left, right) => right.localeCompare(left));
  }

  private async enforceRetention(): Promise<void> {
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    const files = await this.logFilesNewestFirst();
    for (const filePath of files) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(filePath, { force: true });
      }
    }

    const remaining = await this.logFilesNewestFirst();
    let keptBytes = 0;
    for (const [index, filePath] of remaining.entries()) {
      const contents = await fs.readFile(filePath, 'utf8').catch(() => '');
      const bytes = Buffer.byteLength(contents);
      if (keptBytes + bytes <= MAX_LOG_BYTES) {
        keptBytes += bytes;
        continue;
      }

      const available = Math.max(0, MAX_LOG_BYTES - keptBytes);
      if (index === 0 && available > 0) {
        const tail = Buffer.from(contents)
          .subarray(-available)
          .toString('utf8');
        const firstNewline = tail.indexOf('\n');
        await fs.writeFile(
          filePath,
          firstNewline === -1 ? tail : tail.slice(firstNewline + 1),
        );
      } else {
        await fs.rm(filePath, { force: true });
      }
      keptBytes = Math.min(MAX_LOG_BYTES, keptBytes + available);
      for (const stalePath of remaining.slice(index + 1)) {
        await fs.rm(stalePath, { force: true });
      }
      break;
    }
  }
}

function formatLogLine(entry: LogEntry): string {
  const metadata: Record<string, unknown> = {};
  if (entry.taskId) metadata.taskId = entry.taskId;
  if (entry.commitId) metadata.commitId = entry.commitId;
  if (entry.details && Object.keys(entry.details).length > 0) {
    metadata.details = entry.details;
  }
  const suffix =
    Object.keys(metadata).length > 0
      ? `${DETAILS_SEPARATOR}${JSON.stringify(metadata)}`
      : '';
  return `${entry.time} [${entry.level}] [${entry.stage ?? 'LOG'}] ${entry.message}${suffix}`;
}

function parseLogLine(line: string): LogEntry | null {
  if (line.startsWith('{')) {
    try {
      return normalizeEntry(JSON.parse(line) as LogEntry);
    } catch {
      return null;
    }
  }

  const match = TEXT_LOG_PATTERN.exec(line);
  if (!match) return null;
  const [, time, level, stage, remainder] = match;
  let message = remainder;
  let metadata: Record<string, unknown> = {};
  const separatorIndex = remainder.lastIndexOf(DETAILS_SEPARATOR);
  if (separatorIndex >= 0) {
    const possibleMetadata = remainder.slice(
      separatorIndex + DETAILS_SEPARATOR.length,
    );
    try {
      const parsed = JSON.parse(possibleMetadata) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
        message = remainder.slice(0, separatorIndex);
      }
    } catch {
      // Treat the suffix as part of the message when it is not valid metadata.
    }
  }

  return normalizeEntry({
    time,
    level: level as LogLevel,
    stage,
    message,
    ...(typeof metadata.taskId === 'string' ? { taskId: metadata.taskId } : {}),
    ...(typeof metadata.commitId === 'string'
      ? { commitId: metadata.commitId }
      : {}),
    ...(isRecord(metadata.details) ? { details: metadata.details } : {}),
  });
}

function normalizeEntry(entry: LogEntry): LogEntry {
  return {
    time: redactString(String(entry.time)),
    level: entry.level,
    ...(entry.taskId ? { taskId: redactString(entry.taskId) } : {}),
    ...(entry.stage ? { stage: redactString(entry.stage) } : {}),
    message: redactString(String(entry.message ?? '')),
    ...(entry.commitId ? { commitId: redactString(entry.commitId) } : {}),
    ...(isRecord(entry.details)
      ? { details: redactValue(entry.details) as Record<string, unknown> }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function redactString(value: string): string {
  return value
    .replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /(authorization|private-token)\s*[:=]\s*[^\s,}]+/gi,
      '$1=[REDACTED]',
    );
}

export function redactValue(value: unknown, key = ''): unknown {
  if (/^(token|authorization|private-token|content|body)$/i.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}
