import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../ports';
import { DatabaseTaskCases } from './tasks';

function cases(document: (id: string) => Promise<unknown>) {
  const calls: unknown[] = [];
  const api = {
    execute: async <T>(operation: string, payload: unknown) => {
      calls.push([operation, payload]);
      return (operation === 'monitor.status' ? {} : { state: 'passed' }) as T;
    },
    save: async <T>(saved: T) => saved,
    remove: async () => undefined,
    document: document as never,
  };
  return { tasks: new DatabaseTaskCases(api as never), calls };
}

describe('database task cases', () => {
  it('saves a task as a document of its workspace, runs it and reads its next runs', async () => {
    const { tasks, calls } = cases(async () => ({}));
    const saved = await tasks.save('local', 't1', ' Nightly ', { type: 'script' });
    expect(saved).toMatchObject({ id: 't1', kind: 'db-task', name: 'Nightly', revision: 0 });
    const again = await tasks.save('local', 't1', 'Nightly', {}, { ...saved, revision: 4 });
    expect(again.revision).toBe(4);
    await tasks.run('local', 't1');
    expect(await tasks.states('local')).toEqual([]);
    expect(calls).toEqual([
      ['db.task.run', { workspace: 'local', id: 't1' }],
      ['monitor.status', { workspace: 'local', after: 0 }],
    ]);
  });

  it('reads the history of a task, none before its first run', async () => {
    const run = { startedAt: 1, state: 'passed' };
    const read = cases(async (id) => ({ id, value: { runs: [run] } }));
    expect(await read.tasks.history('t1')).toEqual([run]);
    const missing = cases(async () => {
      throw new ApiFailure('Not found', 'not_found', 404);
    });
    expect(await missing.tasks.history('t1')).toEqual([]);
    const broken = cases(async () => {
      throw new ApiFailure('Down', 'unavailable', 503);
    });
    await expect(broken.tasks.history('t1')).rejects.toThrow('Down');
  });
});
