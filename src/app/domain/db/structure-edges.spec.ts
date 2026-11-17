import { describe, expect, it } from 'vitest';
import { editScript, parseInput, tsvBlock } from './edits-sql';
import type { ResultColumn } from './results';
import {
  changeColumn,
  columnChanged,
  newTable,
  readTable,
  removeColumn,
  type TableModel,
} from './structure';

const keyed = (): TableModel => ({
  name: 'orders',
  columns: [
    { name: 'id', original: 'id', typeName: 'integer', nullable: false, identity: true },
    {
      name: 'customer',
      original: 'customer',
      typeName: 'integer',
      nullable: true,
      identity: false,
    },
  ],
  primaryKey: { columns: ['id'] },
  uniques: [{ name: 'u', columns: ['customer'] }],
  checks: [],
  foreignKeys: [{ columns: ['customer'], referencedTable: 'users', referencedColumns: ['id'] }],
  indexes: [{ name: 'i', columns: ['customer DESC'], unique: false }],
});

describe('the structure of a table, at its edges', () => {
  it('starts a new table in a schema or none, and reads an empty model', () => {
    expect(newTable('t', 'shop').schema).toBe('shop');
    expect('schema' in newTable('t')).toBe(false);
    expect(readTable(undefined)).toEqual({
      name: '',
      columns: [],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    });
  });

  it('follows a renamed column into the unique keys, foreign keys and DESC indexes', () => {
    const renamed = changeColumn(keyed(), 1, { name: 'client' });
    expect(renamed.uniques[0].columns).toEqual(['client']);
    expect(renamed.foreignKeys[0].columns).toEqual(['client']);
    expect(renamed.indexes[0].columns).toEqual(['client DESC']);
    expect(changeColumn(keyed(), 9, { name: 'x' })).toEqual(keyed());
    const withoutKey = changeColumn({ ...keyed(), primaryKey: undefined }, 0, { name: 'key' });
    expect(withoutKey.primaryKey).toBeUndefined();
  });

  it('removes a column from its keys, dropping the ones left empty', () => {
    const removed = removeColumn(keyed(), 1);
    expect(removed.uniques).toEqual([]);
    expect(removed.foreignKeys).toEqual([]);
    expect(removed.indexes).toEqual([]);
    expect(removed.primaryKey).toEqual({ columns: ['id'] });
    expect(removeColumn(keyed(), 0).primaryKey).toBeUndefined();
    expect(removeColumn(keyed(), 5)).toEqual(keyed());
  });

  it('tells a changed field, a new column and a column the original has not', () => {
    const original = keyed();
    expect(columnChanged(undefined, original.columns[0], 'name')).toBe(true);
    expect(columnChanged(original, { ...original.columns[0], original: 'gone' }, 'name')).toBe(
      true,
    );
    expect(columnChanged(original, { ...original.columns[1], comment: 'c' }, 'comment')).toBe(true);
    expect(columnChanged(original, original.columns[1], 'default')).toBe(false);
  });
});

describe('edited values and the script of a save, at their edges', () => {
  const column = (kind: string): ResultColumn => ({ name: 'c', typeName: kind, kind });

  it('parses every class of value, or says why it does not fit', () => {
    expect(parseInput('1.5', column('integer'))).toEqual({ error: 'db.edit.notInteger' });
    expect(parseInput('99999999999999999999', column('integer'))).toEqual({
      value: { $t: 'integer', v: '99999999999999999999' },
    });
    expect(parseInput('2.5e3', column('float'))).toEqual({ value: 2500 });
    expect(parseInput('', column('float'))).toEqual({ error: 'db.edit.notNumber' });
    expect(parseInput('x', column('float'))).toEqual({ error: 'db.edit.notNumber' });
    expect(parseInput('1.50', column('decimal'))).toEqual({ value: { $t: 'decimal', v: '1.50' } });
    expect(parseInput('1,5', column('decimal'))).toEqual({ error: 'db.edit.notNumber' });
    expect(parseInput('T', column('boolean'))).toEqual({ value: true });
    expect(parseInput('no', column('boolean'))).toEqual({ value: false });
    expect(parseInput('maybe', column('boolean'))).toEqual({ error: 'db.edit.notBoolean' });
    expect(parseInput('{"a":1}', column('json'))).toEqual({ value: { $t: 'json', v: '{"a":1}' } });
    expect(parseInput('{', column('json'))).toEqual({ error: 'db.edit.notJson' });
    expect(parseInput('AQI=', column('binary'))).toEqual({ error: 'db.edit.binary' });
    expect(parseInput(' 2026-01-02 ', column('date'))).toEqual({
      value: { $t: 'date', v: '2026-01-02' },
    });
    expect(parseInput(' as is ', column('text'))).toEqual({ value: ' as is ' });
  });

  it('reads pasted rows of tabs and lines', () => {
    expect(tsvBlock('a\tb\r\nc\td\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('writes inserts with defaults, deletes by NULL keys and updates', () => {
    const style = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
    const script = editScript(
      { table: 'Orders', key: [0] },
      [
        { kind: 'insert', values: [{ column: 'id', value: null, default: true }] },
        {
          kind: 'insert',
          values: [
            { column: 'id', value: 1 },
            { column: 'note', value: null, default: true },
          ],
        },
        { kind: 'delete', key: [{ column: 'id', value: null }], original: [] },
        {
          kind: 'update',
          key: [{ column: 'id', value: 2 }],
          values: [{ column: 'note', value: null, default: true }],
          original: [],
        },
      ],
      style,
    );
    expect(script.split('\n')).toEqual([
      'INSERT INTO "Orders" DEFAULT VALUES;',
      'INSERT INTO "Orders" (id) VALUES (1);',
      'DELETE FROM "Orders" WHERE id IS NULL;',
      'UPDATE "Orders" SET note = DEFAULT WHERE id = 2;',
    ]);
  });
});
