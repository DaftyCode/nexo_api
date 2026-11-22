import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../models';
import {
  authorizes,
  emptyTaskForm,
  taskForm,
  taskProblem,
  readTaskRuns,
  taskValue,
  type TaskForm,
} from './tasks';

const doc = (value: Record<string, unknown>, id = 't1', name = 'Nightly'): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind: 'db-task',
  name,
  revision: 1,
  updated_at: 0,
  value,
});
const form = (patch: Partial<TaskForm>): TaskForm => ({
  ...emptyTaskForm(),
  name: 'Nightly',
  ...patch,
});

describe('database tasks', () => {
  it('stores only the fields of its type, with its schedule in hours or minutes', () => {
    expect(
      taskValue(
        form({
          scripts: ['s1'],
          connections: ['c1'],
          transaction: true,
          folder: ' Reports ',
          every: 120,
          authorize: { writes: true, everyRow: false, drop: false },
          sql: 'ignored',
        }),
      ),
    ).toEqual({
      type: 'script',
      folder: 'Reports',
      authorize: { writes: true },
      schedule: { every: 2, unit: 'hours' },
      scripts: ['s1'],
      connections: ['c1'],
      onError: 'stop',
      transaction: true,
    });
    expect(
      taskValue(
        form({
          type: 'copy',
          source: 'a',
          target: 'b',
          sql: ' select 1 ',
          table: 'people',
          schema: ' public ',
          every: 15,
          paused: true,
        }),
      ),
    ).toEqual({
      type: 'copy',
      schedule: { every: 15, unit: 'minutes' },
      paused: true,
      source: 'a',
      target: 'b',
      sql: 'select 1',
      table: 'people',
      schema: 'public',
    });
    expect(
      taskValue(form({ type: 'copy', source: 'a', target: 'b', sql: 'x', table: 't' })),
    ).not.toHaveProperty('schema');
    expect(taskValue(form({ type: 'backup', connection: 'c1', file: ' dump.sql ' }))).toEqual({
      type: 'backup',
      connection: 'c1',
      file: 'dump.sql',
      options: {},
    });
    expect(taskValue(form({ type: 'composite', tasks: ['a', 'b'], onError: 'continue' }))).toEqual({
      type: 'composite',
      tasks: ['a', 'b'],
      onError: 'continue',
    });
  });

  it('writes the sides of a comparison as paths, with their table when it compares data', () => {
    const schema = taskValue(
      form({
        type: 'compare',
        source: 'a',
        target: 'b',
        sourcePath: 'shop / schemas/public',
        targetPath: 'copy/schemas/public',
      }),
    );
    expect(schema).toEqual({
      type: 'compare',
      mode: 'schema',
      source: { connection: 'a', path: ['shop', 'schemas', 'public'] },
      target: { connection: 'b', path: ['copy', 'schemas', 'public'] },
    });
    const data = taskValue(
      form({
        type: 'compare',
        mode: 'data',
        source: 'a',
        target: 'b',
        sourcePath: 'shop/people',
        targetPath: '',
      }),
    );
    expect(data['source']).toEqual({ connection: 'a', path: ['shop', 'people'], table: 'people' });
    expect(data['target']).toEqual({ connection: 'b', path: [], table: '' });
  });

  it('reads a saved task back into its form, whatever it lacks', () => {
    for (const value of [
      taskValue(
        form({
          type: 'compare',
          mode: 'data',
          source: 'a',
          target: 'b',
          sourcePath: 'x/y',
          targetPath: 'z/w',
          every: 60,
          authorize: { writes: false, everyRow: true, drop: true },
        }),
      ),
      taskValue(
        form({
          type: 'script',
          scripts: ['s'],
          connections: ['c'],
          onError: 'continue',
          every: 5,
          paused: true,
        }),
      ),
      taskValue(form({ type: 'composite', tasks: ['a'] })),
    ]) {
      const back = taskForm(doc(value));
      expect(taskValue(back)).toEqual(value);
    }
    expect(taskForm(doc({}))).toEqual({ ...emptyTaskForm(), name: 'Nightly' });
    expect(taskForm(doc({ type: 'nothing', scripts: [1, 'a'], folder: 3 })).scripts).toEqual(['a']);
    expect(taskForm({ ...doc({}), value: null as never }).type).toBe('script');
  });

  it('says what keeps a task from being saved', () => {
    expect(taskProblem(emptyTaskForm())).toBe('Give the task a name');
    expect(taskProblem(form({}))).toBe('Choose the scripts the task runs');
    expect(taskProblem(form({ scripts: ['s'] }))).toBe('Choose the connections the scripts run on');
    expect(taskProblem(form({ scripts: ['s'], connections: ['c'] }))).toBe('');
    expect(taskProblem(form({ type: 'copy', source: 'a' }))).toMatch(/connection it reads/);
    expect(taskProblem(form({ type: 'copy', source: 'a', target: 'b', sql: 'x' }))).toMatch(
      /query it reads/,
    );
    expect(
      taskProblem(form({ type: 'copy', source: 'a', target: 'b', sql: 'x', table: 't' })),
    ).toBe('');
    expect(
      taskProblem(form({ type: 'compare', source: 'a', target: 'b', sourcePath: 'x' })),
    ).toMatch(/Each side/);
    expect(taskProblem(form({ type: 'backup', connection: 'c' }))).toMatch(/backup names/);
    expect(taskProblem(form({ type: 'composite' }))).toMatch(/tasks it runs/);
    expect(taskProblem(form({ type: 'composite', tasks: ['a'], every: 7 }))).toBe('db.task.every');
    expect(taskProblem(form({ type: 'composite', tasks: ['a'], every: 1440 }))).toBe('');
  });

  it('reads the runs of its history and whether it authorizes anything', () => {
    const run = {
      startedAt: 1,
      duration: 2,
      trigger: 'manual',
      state: 'passed',
      statements: 1,
      rows: 0,
    };
    expect(readTaskRuns({ runs: [run, 'broken', {}] })).toEqual([run]);
    expect(readTaskRuns({})).toEqual([]);
    expect(readTaskRuns(null)).toEqual([]);
    expect(authorizes(doc({ authorize: { drop: true } }))).toBe(true);
    expect(authorizes(doc({ authorize: { drop: false } }))).toBe(false);
    expect(authorizes(doc({}))).toBe(false);
  });
});
