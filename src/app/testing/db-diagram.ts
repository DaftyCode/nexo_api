/** The database section with a schema of three related tables, for the diagram specs (DB-20). */
import { DbPanelTest, driverHello, node, startDbPanel } from './db-panel';

export const ORDERS = ['shop', 'schemas', 'public', 'tables', 'orders'];
const tables: Record<string, { columns: string[]; keys: [string, string][] }> = {
  orders: { columns: ['id', 'user_id'], keys: [['user_id', 'users']] },
  users: { columns: ['id', 'name'], keys: [] },
  lines: { columns: ['id', 'order_id'], keys: [['order_id', 'orders']] },
};

/** `db.ddl.model` of the three tables. */
function model(payload: Record<string, unknown>) {
  const name = (payload['path'] as string[]).at(-1)!;
  const table = tables[name];
  if (!table) throw new Error(`No table ${name}`);
  return {
    table: {
      schema: 'public',
      name,
      columns: table.columns.map((column) => ({
        name: column,
        typeName: column === 'name' ? 'text' : 'int4',
        nullable: column !== 'id',
      })),
      primaryKey: { columns: ['id'] },
      foreignKeys: table.keys.map(([column, target]) => ({
        name: `${name}_${column}_fkey`,
        columns: [column],
        referencedSchema: 'public',
        referencedTable: target,
        referencedColumns: ['id'],
      })),
    },
  };
}

/** `db.describe`: the object tab's description, and what references each table. */
function describe(payload: Record<string, unknown>) {
  const name = (payload['path'] as string[]).at(-1)!;
  const referencing = Object.entries(tables)
    .filter(([, table]) => table.keys.some(([, target]) => target === name))
    .map(([other]) => [`${other}_fkey`, 'public', other]);
  return {
    kind: name in tables ? 'table' : 'schema',
    name: `public.${name}`,
    properties: [],
    sections: [
      { id: 'columns', title: 'Columns', columns: ['Name'], rows: [['id']] },
      {
        id: 'references',
        title: 'Referenced by',
        columns: ['Name', 'Schema', 'Table name'],
        rows: referencing,
      },
    ],
  };
}

export async function startDiagramPanel(
  options: {
    documents?: Parameters<typeof startDbPanel>[0]['documents'];
    /** The driver also edits the structure of tables (`ddl.plan`). */
    structure?: boolean;
    /** The schema opens in a tab of its own. */
    opens?: boolean;
  } = {},
) {
  const panel = await startDbPanel({
    hello: driverHello({ methods: ['ddl.model', ...(options.structure ? ['ddl.plan'] : [])] }),
    tree: {
      '': [node('database', 'shop')],
      shop: [node('folder', 'schemas')],
      'shop/schemas': [node('schema', 'public', options.opens ? { actions: ['open'] } : {})],
      'shop/schemas/public': [node('folder', 'tables')],
      'shop/schemas/public/tables': [node('table', 'orders'), node('table', 'users')],
    },
    responses: { 'db.ddl.model': model, 'db.describe': describe },
    documents: options.documents,
  });
  return panel;
}

/** Opens the navigator down to the schema `public`. */
export async function openSchema(panel: DbPanelTest) {
  await panel.open('Shop', 'shop', 'schemas');
}

/** The element of an entity of the diagram, by its key. */
export function entity(panel: DbPanelTest, key: string) {
  const found = panel.root().querySelector<SVGGElement>(`.erd-entity[data-key="${key}"]`);
  if (!found) throw new Error(`No entity ${key}`);
  return found;
}
export const entities = (panel: DbPanelTest) =>
  [...panel.root().querySelectorAll('.erd-entity')].map((each) => each.getAttribute('data-key'));

/** A pointer event, as a mouse makes it (jsdom has no `PointerEvent`). */
export function pointer(target: Element, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
}
export function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
}
/** Chooses an option of a `select` by its value. */
export function choose(select: Element, value: string) {
  (select as HTMLSelectElement).value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
/** Where an entity is drawn. */
export function placeOf(element: Element) {
  const [x, y] = (element.getAttribute('transform') ?? '')
    .replace(/[^\d. -]/g, '')
    .trim()
    .split(/\s+/)
    .map(Number);
  return { x, y };
}
