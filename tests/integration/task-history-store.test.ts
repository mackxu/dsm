import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTaskSnapshot, type TaskSnapshot } from '@dsm/core';

import { TaskHistoryStore } from '../../apps/desktop/src/main/task-history-store.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsm-task-history-'));
  temporaryDirectories.push(directory);
  return directory;
}

function finishedTask(
  taskId: string,
  fileName: string,
  status: TaskSnapshot['status'] = 'SUCCESS',
): TaskSnapshot {
  return {
    ...createTaskSnapshot(taskId, fileName, `/tmp/${fileName}`, new Date()),
    status,
    stage: null,
  };
}

describe('TaskHistoryStore', () => {
  it('keeps the two most recent finished tasks, newest first', async () => {
    const directory = await temporaryDirectory();
    const store = new TaskHistoryStore(directory);

    await store.record(finishedTask('task-1', 'one.txt'));
    await store.record(finishedTask('task-2', 'two.txt', 'FAILED'));
    await store.record(finishedTask('task-3', 'three.txt'));

    const tasks = await store.list();
    expect(tasks.map((task) => task.taskId)).toEqual(['task-3', 'task-2']);
  });

  it('ignores unfinished tasks and reloads finished tasks from disk', async () => {
    const directory = await temporaryDirectory();
    const store = new TaskHistoryStore(directory);

    await store.record(createTaskSnapshot('running', 'running.txt', '/tmp/running.txt'));
    await store.record(finishedTask('task-1', 'one.txt'));

    expect((await store.list()).map((task) => task.taskId)).toEqual(['task-1']);

    const reloaded = new TaskHistoryStore(directory);
    expect((await reloaded.list()).map((task) => task.taskId)).toEqual([
      'task-1',
    ]);
  });
});
