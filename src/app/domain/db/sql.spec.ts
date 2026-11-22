import { VariableScopes } from '../variables';
import {
  Classification,
  confirmationOf,
  databaseOf,
  qualifiedName,
  readHistory,
  readScript,
  withVariables,
} from './sql';
import { DbNode } from './tree';

const scopes: VariableScopes = {
  environment: [{ key: 'schema', value: 'shop', enabled: true, secret: false }],
  collection: [],
  globals: [],
};
const classify = (change: Partial<Classification> = {}): Classification => ({
  kind: 'read',
  missingWhere: false,
  truncate: false,
  drop: [],
  drops: false,
  ...change,
});
const node = (kind: string, label: string): DbNode => ({
  kind,
  name: label,
  label,
  hasChildren: true,
  actions: [],
});

describe('the SQL editor decisions', () => {
  it('replaces variables and names the ones without a value', () => {
    expect(withVariables('select * from {{ schema }}.orders', scopes)).toBe(
      'select * from shop.orders',
    );
    expect(() => withVariables('select {{missing}}', scopes)).toThrow(/missing/);
    expect(() => withVariables('select {{vault:key}}', scopes)).toThrow(/Vault/);
  });

  it('asks what the backend will demand, before sending', () => {
    const none = { confirmWrites: false, confirmStructure: false };
    const all = { confirmWrites: true, confirmStructure: true };
    expect(confirmationOf(classify(), all)).toBeUndefined();
    expect(confirmationOf(classify({ kind: 'write' }), none)).toBeUndefined();
    expect(confirmationOf(classify({ kind: 'write' }), all)?.message).toBe('db.confirm.production');
    expect(confirmationOf(classify({ kind: 'write', missingWhere: true }), none)?.message).toBe(
      'db.confirm.everyRow',
    );
    expect(confirmationOf(classify({ kind: 'write', truncate: true }), none)?.message).toBe(
      'db.confirm.truncate',
    );
    expect(
      confirmationOf(classify({ kind: 'structure', drops: true, drop: ['a', 'b'] }), none),
    ).toEqual({ message: 'db.confirm.dropNamed', params: { v0: 'a, b' }, names: 'a, b' });
    expect(
      confirmationOf(classify({ kind: 'structure', drops: true }), none)?.names,
    ).toBeUndefined();
    // A type of your own may confirm only changes of structure.
    const structure = { confirmWrites: false, confirmStructure: true };
    expect(confirmationOf(classify({ kind: 'write' }), structure)).toBeUndefined();
    expect(confirmationOf(classify({ kind: 'structure' }), structure)?.message).toBe(
      'db.confirm.structure',
    );
  });

  it('writes the name of a tree object with its schema, quoted as needed', () => {
    const style = { quoteOpen: '"', quoteClose: '"' };
    const nodes = [
      node('database', 'shop'),
      node('folder', 'Schemas'),
      node('schema', 'Sales'),
      node('folder', 'Tables'),
      node('table', 'orders'),
    ];
    expect(qualifiedName(nodes, style)).toBe('"Sales".orders');
    expect(qualifiedName([node('table', 'orders')], style)).toBe('orders');
    expect(databaseOf(nodes)).toBe('shop');
  });

  it('reads scripts and history entries defensively', () => {
    expect(readScript({ connectionId: 'a', sql: 'select 1', folder: ' ' })).toEqual({
      connectionId: 'a',
      sql: 'select 1',
    });
    expect(readHistory('h', { sql: 'x' })).toBeUndefined();
    expect(
      readHistory('h', { connectionId: 'a', sql: 'x', startedAt: 5, durationMs: 2, rows: 3 }),
    ).toEqual({ id: 'h', connectionId: 'a', sql: 'x', startedAt: 5, durationMs: 2, rows: 3 });
  });
});
