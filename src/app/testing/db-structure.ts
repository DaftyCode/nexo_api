/** The structure editor in a test (DB-19): a table, its tree and what the fake driver plans. */
import { DbPanelTest, driverHello, node, startDbPanel } from './db-panel';

export const orders = {
  name: 'orders',
  original: 'orders',
  schema: 'public',
  columns: [
    { name: 'id', original: 'id', typeName: 'integer', nullable: false, identity: true },
    { name: 'note', original: 'note', typeName: 'text', nullable: true, identity: false },
  ],
  primaryKey: { columns: ['id'] },
};
export const tree = {
  '': [node('folder', 'tables', { label: 'Tables' }), node('folder', 'views', { label: 'Views' })],
  tables: [node('table', 'orders')],
};

/** What the fake driver plans: the change it was asked, as one statement each. */
export function plan(payload: Record<string, unknown>) {
  const target = payload['target'] as { name: string } | undefined;
  const original = payload['original'] as { name: string } | undefined;
  if (!target)
    return {
      statements: [`DROP TABLE ${original?.name}${payload['cascade'] ? ' CASCADE' : ''}`],
      warnings: [],
      transactional: true,
    };
  if (!original)
    return {
      statements: [`CREATE TABLE ${target.name} (id integer)`],
      warnings: [],
      transactional: true,
    };
  return {
    statements: [`ALTER TABLE ${target.name} ADD x int`, `COMMENT ON TABLE ${target.name} IS 'c'`],
    warnings: ['The column note is dropped with its values'],
    transactional: false,
  };
}

export async function start(extra: { failing?: boolean; methods?: string[] } = {}) {
  return startDbPanel({
    tree,
    hello: driverHello({ methods: extra.methods ?? ['ddl.model', 'ddl.plan'] }),
    responses: {
      'db.ddl.model': (payload: Record<string, unknown>) =>
        payload['path'] ? { table: orders, types: ['integer', 'text'] } : { types: ['integer'] },
      'db.ddl.plan': plan,
      'db.execute': () => {
        if (extra.failing) throw new Error('permission denied');
        return { columns: [], rows: [], elapsedMs: 1 };
      },
      'db.describe': () => ({
        kind: 'table',
        name: 'orders',
        properties: [],
        sections: [{ id: 'columns', title: 'Columns', columns: ['Name'], rows: [] }],
      }),
      'db.ddl': () => ({ sql: '' }),
    },
  });
}

export const input = (panel: DbPanelTest, label: string) =>
  panel.control(label, panel.dialog()) as HTMLInputElement;
export async function change(
  panel: DbPanelTest,
  target: HTMLInputElement,
  value: string | boolean,
) {
  if (typeof value === 'boolean') target.checked = value;
  else target.value = value;
  target.dispatchEvent(new Event(typeof value === 'boolean' ? 'change' : 'input'));
  target.dispatchEvent(new Event('change'));
  await panel.settle();
}
