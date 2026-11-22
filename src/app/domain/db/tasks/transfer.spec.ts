import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../../models';
import { emptyTaskForm, taskForm, taskProblem, taskValue, type TaskForm } from '../tasks';
import { cronProblem, readTransferFields } from './transfer';

const form = (patch: Partial<TaskForm>): TaskForm => ({
  ...emptyTaskForm(),
  name: 'Nightly',
  ...patch,
});
const saved = (value: Record<string, unknown>): WorkspaceDocument => ({
  id: 't1',
  workspace_id: 'local',
  kind: 'db-task',
  name: 'Nightly',
  revision: 1,
  updated_at: 0,
  value,
});

describe('tasks with files and MongoDB', () => {
  it('stores only the fields of each type and reads them back', () => {
    const cases: Partial<TaskForm>[] = [
      {
        type: 'export',
        connection: 'c1',
        sql: ' select 1 ',
        file: ' /out/{date}.csv ',
        separator: ';',
        header: false,
        overwrite: true,
      },
      { type: 'export', connection: 'c1', sql: 'x', file: '/o.json', format: 'json' },
      {
        type: 'import',
        connection: 'c1',
        file: '/in/t.csv',
        table: ' people ',
        schema: 'public',
        importMode: 'upsert',
        key: 'id, code',
        separator: ';',
      },
      { type: 'import', connection: 'c1', file: '/in/t.jsonl', table: 't', format: 'jsonl' },
      { type: 'mongo-transfer', transfer: 'tr', file: '/o.jsonl', overwrite: true },
      { type: 'mongo-transfer', transfer: 'tr' },
      { type: 'mongo-compare', comparison: 'cmp', sync: true, cron: ' 0 9 * * mon-fri ' },
      { type: 'mongo-compare', comparison: 'cmp' },
    ];
    for (const patch of cases) {
      const value = taskValue(form(patch));
      expect(taskValue(taskForm(saved(value)))).toEqual(value);
    }
    expect(taskValue(form(cases[0]))).toEqual({
      type: 'export',
      connection: 'c1',
      sql: 'select 1',
      format: 'csv',
      file: '/out/{date}.csv',
      overwrite: true,
      separator: ';',
      header: false,
    });
    expect(taskValue(form(cases[2]))).toMatchObject({ mode: 'upsert', key: ['id', 'code'] });
    expect(taskValue(form(cases[6]))).toMatchObject({
      schedule: { cron: '0 9 * * mon-fri' },
      sync: true,
    });
    expect(taskForm(saved({ schedule: { cron: '*/5 * * * *' } })).cron).toBe('*/5 * * * *');
    expect(readTransferFields({ format: 'xml', key: 'x' })).toMatchObject({
      format: 'csv',
      key: '',
    });
  });

  it('says what keeps them from being saved', () => {
    expect(taskProblem(form({ type: 'export', connection: 'c1' }))).toMatch(
      /its connection and its file/,
    );
    expect(taskProblem(form({ type: 'export', connection: 'c1', file: 'f' }))).toMatch(/the query/);
    expect(taskProblem(form({ type: 'import', connection: 'c1', file: 'f' }))).toMatch(/the table/);
    expect(
      taskProblem(
        form({ type: 'import', connection: 'c1', file: 'f', table: 't', importMode: 'upsert' }),
      ),
    ).toMatch(/columns of its key/);
    expect(taskProblem(form({ type: 'import', connection: 'c1', file: 'f', table: 't' }))).toBe('');
    expect(taskProblem(form({ type: 'mongo-transfer' }))).toMatch(/saved MongoDB transfer/);
    expect(taskProblem(form({ type: 'mongo-compare' }))).toMatch(/saved MongoDB comparison/);
    expect(taskProblem(form({ type: 'mongo-compare', comparison: 'c', cron: '0 9 *' }))).toBe(
      'db.task.cron',
    );
    expect(cronProblem('0 9 * * 1-5')).toBe('');
  });
});
