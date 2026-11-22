import { describe, expect, it } from 'vitest';
import { MOCK_KINDS, autoGenerator, generatorOf, mockColumns, mockPlan, typeSize } from './mock';
import type { ColumnModel, TableModel } from './structure';

const column = (name: string, typeName: string, extra: Partial<ColumnModel> = {}): ColumnModel => ({
  name,
  typeName,
  nullable: true,
  identity: false,
  ...extra,
});
const table: TableModel = {
  name: 'orders',
  columns: [
    column('id', 'int4', { nullable: false }),
    column('serial_no', 'integer', { identity: true }),
    column('created', 'timestamptz', { default: 'now()' }),
    column('email', 'varchar(60)'),
    column('user_id', 'bigint'),
    column('total', 'numeric(6,2)'),
  ],
  primaryKey: { columns: ['id'] },
  uniques: [{ columns: ['email'] }],
  checks: [],
  foreignKeys: [
    {
      columns: ['user_id'],
      referencedSchema: 'public',
      referencedTable: 'users',
      referencedColumns: ['id'],
    },
  ],
  indexes: [],
};

describe('test data for a table', () => {
  it('reads the size a type says', () => {
    expect(typeSize('varchar(40)')).toEqual({ length: 40 });
    expect(typeSize('numeric(10, 2)')).toEqual({ precision: 10, scale: 2 });
    expect(typeSize('float(24)')).toEqual({ precision: 24 });
    expect(typeSize('text')).toEqual({});
  });

  it('chooses a generator from the type and the name of each column', () => {
    const pick = (name: string, type: string) => autoGenerator(column(name, type), table, 'es');
    expect(pick('id', 'int4')).toEqual({ kind: 'sequence', start: 1, step: 1 });
    expect(pick('n', 'smallint')).toEqual({ kind: 'integer', min: 1, max: 32_767 });
    expect(pick('n', 'tinyint')).toMatchObject({ max: 127 });
    expect(pick('flag', 'tinyint(1)')).toEqual({ kind: 'boolean', ratio: 0.5 });
    expect(pick('ok', 'boolean')).toEqual({ kind: 'boolean', ratio: 0.5 });
    expect(pick('total', 'numeric(6,2)')).toEqual({
      kind: 'decimal',
      min: 0,
      max: 9_999,
      scale: 2,
    });
    expect(pick('price', 'money')).toEqual({ kind: 'decimal', min: 0, max: 10_000, scale: 2 });
    expect(pick('key', 'uuid')).toEqual({ kind: 'catalog', catalog: 'uuid', language: 'es' });
    expect(pick('data', 'jsonb')).toMatchObject({ kind: 'json' });
    expect(pick('photo', 'bytea')).toEqual({ kind: 'binary', size: 16 });
    expect(pick('at', 'datetime')).toMatchObject({ kind: 'timestamp' });
    expect(pick('day', 'date')).toMatchObject({ kind: 'date' });
    expect(pick('opens', 'time')).toMatchObject({ kind: 'list' });
    expect(pick('user_id', 'bigint')).toEqual({ kind: 'foreign', values: [] });
    for (const [name, catalog] of [
      ['contact_email', 'email'],
      ['phone', 'phone'],
      ['first_name', 'firstName'],
      ['surname', 'lastName'],
      ['full_name', 'fullName'],
      ['city', 'city'],
      ['country', 'country'],
      ['company', 'company'],
      ['address', 'street'],
      ['iban', 'iban'],
      ['website', 'url'],
      ['guid', 'uuid'],
    ])
      expect(pick(name, 'varchar(80)')).toMatchObject({ kind: 'catalog', catalog });
    expect(pick('notes', 'varchar(12)')).toEqual({ kind: 'text', min: 5, max: 12 });
    expect(pick('notes', 'text')).toEqual({ kind: 'text', min: 5, max: 30 });
  });

  it('leaves out what the database fills, and knows the unique and the foreign columns', () => {
    const plan = mockPlan(table);
    expect(plan.map((each) => [each.name, each.include, each.filled ?? '', each.unique])).toEqual([
      ['id', true, '', true],
      ['serial_no', false, 'identity', false],
      ['created', false, 'default', false],
      ['email', true, '', true],
      ['user_id', true, '', false],
      ['total', true, '', false],
    ]);
    expect(plan[3].length).toBe(60);
    expect(plan[4].foreign?.referencedTable).toBe('users');
    const columns = mockColumns(
      plan.map((each) => (each.name === 'id' ? { ...each, nulls: 0.5 } : { ...each, nulls: 0.2 })),
      { user_id: [1, 2] },
    );
    expect(columns.map((each) => each['name'])).toEqual(['id', 'email', 'user_id', 'total']);
    // A column that takes no NULL gets none.
    expect(columns[0]['nulls']).toBe(0);
    expect(columns[2]).toMatchObject({
      generator: { kind: 'foreign', values: [1, 2] },
      nulls: 0.2,
    });
    expect(columns[1]).toMatchObject({ unique: true, length: 60 });
    const unread = mockColumns([{ ...plan[4], generator: { kind: 'foreign', values: [7] } }]);
    expect(unread[0]['generator']).toEqual({ kind: 'foreign', values: [7] });
  });

  it('gives each kind of generator its usual settings', () => {
    for (const kind of MOCK_KINDS) expect(generatorOf(kind, 'es').kind).toBe(kind);
    expect(generatorOf('catalog', 'es')).toEqual({
      kind: 'catalog',
      catalog: 'fullName',
      language: 'es',
    });
  });
});
