import { describe, expect, it } from 'vitest';
import { emptyDiagram } from '../domain/db/erd-document';
import { databaseCases } from '../testing/database-cases';

const node = (kind: string, name: string, system = false) => ({
  kind,
  name,
  label: name,
  hasChildren: true,
  actions: [],
  system,
});
const tree: Record<string, unknown[]> = {
  shop: [node('folder', 'schemas'), node('folder', 'roles', true)],
  'shop/schemas': [node('schema', 'public'), node('schema', 'pg_catalog', true)],
  'shop/schemas/public': [node('folder', 'tables'), node('folder', 'views')],
  'shop/schemas/public/tables': [node('table', 'orders'), node('table', 'users')],
};

describe('the diagram use cases', () => {
  it('finds the tables under a database, leaving out system objects and views', async () => {
    const { cases } = databaseCases({
      'db.tree': (payload: Record<string, unknown>) => ({
        nodes: tree[(payload['path'] as string[]).join('/')] ?? [],
      }),
    });
    expect(await cases.diagrams.tables('w', 's', ['shop'])).toEqual([
      { path: ['shop', 'schemas', 'public', 'tables', 'orders'], name: 'orders', schema: 'public' },
      { path: ['shop', 'schemas', 'public', 'tables', 'users'], name: 'users', schema: 'public' },
    ]);
  });

  it('reads tables a few at a time, from their structure or their description', async () => {
    const { cases, named } = databaseCases({
      'db.ddl.model': (payload: Record<string, unknown>) => ({
        table: {
          name: (payload['path'] as string[]).at(-1),
          columns: [{ name: 'id', typeName: 'int' }],
          primaryKey: { columns: ['id'] },
        },
      }),
      'db.describe': () => ({
        sections: [
          { id: 'columns', columns: ['Name', 'Type', 'Nullable'], rows: [['id', 'int', 'NO']] },
        ],
      }),
    });
    const tables = Array.from({ length: 8 }, (_, at) => ({
      path: ['tables', `t${at}`],
      name: `t${at}`,
      schema: 'main',
    }));
    const counted: number[] = [];
    const read = await cases.diagrams.read('w', 's', tables, true, (count) => counted.push(count));
    expect(read).toHaveLength(8);
    expect(read[0].entity).toMatchObject({ key: 'main.t0', schema: 'main' });
    expect(counted).toEqual([6, 8]);
    const failing = databaseCases({
      'db.ddl.model': (payload: Record<string, unknown>) => {
        if ((payload['path'] as string[]).at(-1) === 't1') throw new Error('gone');
        return { table: { name: 't0', columns: [] } };
      },
    });
    expect(await failing.cases.diagrams.read('w', 's', tables.slice(0, 2), true)).toHaveLength(1);
    await expect(failing.cases.diagrams.read('w', 's', tables.slice(1, 2), true)).rejects.toThrow(
      'gone',
    );
    const described = await cases.diagrams.read('w', 's', tables.slice(0, 1), false);
    expect(described[0].entity.columns[0]).toMatchObject({ name: 'id', nullable: false });
    expect(named('db.describe')).toHaveLength(1);
  });

  it('finds the tables that reference one, also in another schema, once each', async () => {
    const { cases } = databaseCases({
      'db.describe': () => ({
        sections: [
          {
            id: 'references',
            columns: ['Name', 'Schema', 'Table name'],
            rows: [
              ['fk1', 'public', 'orders'],
              ['fk2', 'public', 'orders'],
              ['fk3', 'audit', 'log'],
              ['fk4', 'public', ''],
            ],
          },
        ],
      }),
    });
    const users = {
      path: ['shop', 'schemas', 'public', 'tables', 'users'],
      name: 'users',
      schema: 'public',
    };
    expect(await cases.diagrams.references('w', 's', users)).toEqual([
      { path: ['shop', 'schemas', 'public', 'tables', 'orders'], name: 'orders', schema: 'public' },
      { path: ['shop', 'schemas', 'audit', 'tables', 'log'], name: 'log', schema: 'audit' },
    ]);
    const bare = databaseCases({ 'db.describe': () => ({ sections: [] }) });
    expect(await bare.cases.diagrams.references('w', 's', users)).toEqual([]);
  });

  it('reads a table with the ones it references and the ones referencing it, once each', async () => {
    const model = (name: string, keys: unknown[] = []) => ({
      table: {
        schema: 'public',
        name,
        columns: [{ name: 'id', typeName: 'int' }],
        primaryKey: { columns: ['id'] },
        foreignKeys: keys,
      },
    });
    const { cases, named } = databaseCases({
      'db.ddl.model': (payload: Record<string, unknown>) => {
        const name = (payload['path'] as string[]).at(-1)!;
        return name === 'orders'
          ? model('orders', [
              { columns: ['user'], referencedTable: 'users', referencedColumns: ['id'] },
              { columns: ['me'], referencedTable: 'orders', referencedColumns: ['id'] },
            ])
          : model(name);
      },
      'db.describe': () => ({
        sections: [
          {
            id: 'references',
            columns: ['Schema', 'Table name'],
            rows: [
              ['public', 'lines'],
              ['public', 'users'],
            ],
          },
        ],
      }),
    });
    const orders = {
      path: ['shop', 'schemas', 'public', 'tables', 'orders'],
      name: 'orders',
      schema: 'public',
    };
    const read = await cases.diagrams.related('w', 's', orders, true);
    expect(read.map((table) => table.entity.key)).toEqual([
      'public.orders',
      'public.users',
      'public.lines',
    ]);
    expect(named('db.ddl.model')).toHaveLength(3);
  });

  it('saves and removes a diagram of the person', async () => {
    const { cases, saved } = databaseCases();
    const document = await cases.diagrams.save('w', 'd1', ' ', emptyDiagram('c1'));
    expect(saved[0]).toMatchObject({ id: 'd1', kind: 'db-diagram', name: 'Diagram', revision: 0 });
    await cases.diagrams.save('w', 'd1', 'Shop', emptyDiagram('c1'), { ...document, revision: 4 });
    expect(saved[1]).toMatchObject({ name: 'Shop', revision: 4 });
    await cases.diagrams.remove(document);
  });
});
