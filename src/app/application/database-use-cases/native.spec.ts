import { emptyNativeForm } from '../../domain/db/native';
import { ExecutionPort } from '../ports';
import { DatabaseNativeCases } from './native';

describe('DatabaseNativeCases', () => {
  const calls: [string, Record<string, unknown>][] = [];
  const api = {
    async execute(operation: string, payload: Record<string, unknown>) {
      calls.push([operation, payload]);
      return operation === 'native.status'
        ? { tool: 'pg_dump', state: 'finished', lines: ['ok'], dropped: 0, seconds: 2 }
        : { id: 'run', tool: 'pg_dump', version: '18' };
    },
  } as unknown as ExecutionPort;
  const cases = new DatabaseNativeCases(api);
  const request = {
    workspace: 'w',
    connection: 'c1',
    driver: 'postgres',
    path: '/b.sql',
    form: emptyNativeForm(),
  };

  beforeEach(() => (calls.length = 0));

  it('finds the tool, in a folder of its own when one is given', async () => {
    await cases.locate('w', 'c1', 'server');
    await cases.locate('w', 'c1', 'script', ' /opt/pg/bin ');
    expect(calls).toEqual([
      ['native.locate', { workspace: 'w', connection: 'c1', need: 'server' }],
      [
        'native.locate',
        { workspace: 'w', connection: 'c1', need: 'script', folder: '/opt/pg/bin' },
      ],
    ]);
  });

  it('starts each action with what it asks for, and follows and cancels a run', async () => {
    await cases.start({ ...request, action: 'backup' });
    await cases.start({
      ...request,
      action: 'restore',
      form: { ...emptyNativeForm(), database: ' copy ', minutes: '1' },
      variables: { host: 'db' },
      confirmName: 'copy',
      confirm: true,
    });
    await cases.start({ ...request, action: 'script' });
    expect(calls.map(([operation]) => operation)).toEqual([
      'native.backup',
      'native.restore',
      'native.script',
    ]);
    expect(calls[0][1]).not.toHaveProperty('confirm');
    expect(calls[1][1]).toMatchObject({
      database: 'copy',
      variables: { host: 'db' },
      confirmName: 'copy',
      confirm: true,
      timeoutSeconds: 60,
    });
    expect((await cases.status('run')).lines).toEqual(['ok']);
    await cases.cancel('run');
    expect(calls.slice(-2)).toEqual([
      ['native.status', { id: 'run' }],
      ['native.cancel', { id: 'run' }],
    ]);
  });
});
