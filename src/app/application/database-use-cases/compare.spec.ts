import { ExecutionPort } from '../ports';
import { DatabaseCompareCases } from './compare';

describe('DatabaseCompareCases', () => {
  const calls: [string, Record<string, unknown>][] = [];
  const trees: Record<string, unknown[]> = {
    '': [
      { kind: 'database', name: 'shop', label: 'shop' },
      { kind: 'database', name: 'postgres', label: 'postgres', system: true },
    ],
    shop: [{ kind: 'folder', name: 'schemas', label: 'Schemas' }],
    'shop/schemas': [{ kind: 'schema', name: 'sales', label: 'sales' }],
    'shop/schemas/sales': [{ kind: 'folder', name: 'tables', label: 'Tables' }],
    'shop/schemas/sales/tables': [{ kind: 'table', name: 'orders', label: 'orders' }],
  };
  const api = {
    async execute(operation: string, payload: Record<string, unknown>) {
      calls.push([operation, payload]);
      if (operation === 'db.tree')
        return { nodes: trees[(payload['path'] as string[]).join('/')] ?? [] };
      if (operation === 'db.cancel') throw new Error('gone');
      return {
        objects: [],
        counts: {},
        statements: ['A;'],
        warnings: ['w', { text: 'k', params: { v0: 2 } }, { params: {} }],
        inserted: 1,
      };
    },
  } as unknown as ExecutionPort;
  const cases = new DatabaseCompareCases(api);
  const source = {
    session: 's',
    path: ['shop', 'schemas', 'sales', 'tables', 'orders'],
    table: true,
  };
  const target = { session: 't', path: ['tables', 'orders'], table: true };
  const structure = { ignoreComments: false, ignoreColumnOrder: true, ignoreConstraintNames: true };
  const data = { key: ['id'], ignore: [], filter: ' qty > 0 ' };

  beforeEach(() => (calls.length = 0));

  it('finds the schemas and the tables of a connection that can be compared', async () => {
    expect(await cases.candidates('w', 'tree', 'schema')).toEqual([
      { path: ['shop'], label: 'shop' },
      { path: ['shop', 'schemas', 'sales'], label: 'shop / sales' },
    ]);
    expect(await cases.candidates('w', 'tree', 'table')).toEqual([
      { path: ['shop', 'schemas', 'sales', 'tables', 'orders'], label: 'shop / sales / orders' },
    ]);
  });

  it('asks the backend for each comparison with its sides and options', async () => {
    await cases.structure('w', source, target, structure);
    expect(await cases.script('w', source, target, structure, true)).toEqual({
      statements: ['A;'],
      warnings: [
        { text: 'w', params: {} },
        { text: 'k', params: { v0: '2' } },
      ],
    });
    await cases.data('w', source, target, data, 'cmp');
    expect(
      await cases.dataScript(
        'w',
        source,
        target,
        { key: [], ignore: ['note'], filter: '' },
        'cmp',
        true,
      ),
    ).toEqual(['A;']);
    await cases.sync('w', source, target, data, 'cmp', {
      remove: false,
      name: 'orders',
      production: true,
    });
    await cases.cancel('w', ['s', 't'], 'cmp');
    expect(calls.map(([operation]) => operation)).toEqual([
      'db.compare.schema',
      'db.compare.script',
      'db.compare.data',
      'db.sync.data',
      'db.sync.data',
      'db.cancel',
      'db.cancel',
    ]);
    expect(calls[0][1]).toEqual({ workspace: 'w', source, target, ...structure });
    expect(calls[2][1]).toEqual({
      workspace: 'w',
      source: { session: 's', path: source.path, schema: 'sales', table: 'orders' },
      target: { session: 't', path: target.path, table: 'orders' },
      statement: 'cmp',
      key: ['id'],
      filter: 'qty > 0',
    });
    expect(calls[3][1]).toMatchObject({ ignore: ['note'], script: true, delete: true });
    expect(calls[4][1]).toMatchObject({ delete: false, confirmName: 'orders', confirm: true });
  });
});
