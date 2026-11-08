import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TaskSnapshot } from '@dsm/core';

const MAX_TASKS = 2;

const FINAL_STATUSES: ReadonlySet<TaskSnapshot['status']> = new Set([
  'SUCCESS',
  'SUCCESS_WITH_WARNING',
  'FAILED',
]);

export class TaskHistoryStore {
  private readonly historyPath: string;
  private cached: TaskSnapshot[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly userDataDirectory: string) {
    this.historyPath = path.join(userDataDirectory, 'task-history.json');
  }

  async list(): Promise<TaskSnapshot[]> {
    if (this.cached) {
      return structuredClone(this.cached);
    }

    try {
      const contents = await fs.readFile(this.historyPath, 'utf8');
      const parsed = JSON.parse(contents) as unknown;
      this.cached = Array.isArray(parsed)
        ? parsed.filter(isTaskSnapshot).slice(0, MAX_TASKS)
        : [];
    } catch {
      this.cached = [];
    }
    return structuredClone(this.cached);
  }

  record(snapshot: TaskSnapshot): Promise<void> {
    if (!FINAL_STATUSES.has(snapshot.status)) {
      return Promise.resolve();
    }

    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const current = await this.list();
        const next = [
          structuredClone(snapshot),
          ...current.filter((task) => task.taskId !== snapshot.taskId),
        ].slice(0, MAX_TASKS);
        await this.write(next);
      });
    return this.writeQueue;
  }

  private async write(tasks: TaskSnapshot[]): Promise<void> {
    await fs.mkdir(this.userDataDirectory, { recursive: true });
    const temporaryPath = path.join(
      this.userDataDirectory,
      `.task-history-${process.pid}-${Date.now()}.tmp`,
    );
    await fs.writeFile(temporaryPath, `${JSON.stringify(tasks, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporaryPath, this.historyPath);
    this.cached = tasks;
  }
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === 'string' &&
    typeof record.status === 'string' &&
    FINAL_STATUSES.has(record.status as TaskSnapshot['status']) &&
    typeof record.updatedAt === 'string'
  );
}
