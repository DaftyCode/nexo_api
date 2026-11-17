import {
  CompletionContext,
  CompletionResult,
  autocompletion,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { DatabaseUseCases } from '../../application/database-use-cases';
import { assistFor } from './assist-source';
import { SchemaCache } from './schema-cache';
import type { DbSection } from './section';
import { SqlAssistSource, sqlAssist } from './sql-assist';
import type { SqlRunner } from './sql-runner';

const node = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  kind,
  name,
  label: name,
  hasChildren: kind !== 'table' && kind !== 'view',
  actions: [],
  ...extra,
});
const tree: Record<string, unknown[]> = {
  '': [node('database', 'other'), node('database', 'shop')],
  shop: [node('folder', 'schemas'), node('folder', 'roles', { system: true })],
  'shop/schemas': [node('schema', 'public')],
  'shop/schemas/public': [node('folder', 'tables'), node('folder', 'views')],
  'shop/schemas/public/tables': [node('table', 'orders'), node('table', 'users')],
  'shop/schemas/public/views': [node('view', 'totals')],
};
const described = {
  sections: [
    {
      id: 'columns',
      columns: ['Name', 'Type'],
      rows: [
        ['id', 'int4'],
        ['user_id', { $t: 'text', v: 'int4' }],
        [null, null],
      ],
    },
    {
      id: 'foreign-keys',
      columns: ['Columns', 'Referenced table', 'Referenced columns'],
      rows: [['user_id', 'users', 'id']],
    },
  ],
};

function fixture(options: { open?: boolean; failing?: boolean } = {}) {
  const asked: string[] = [];
  const opened: unknown[] = [];
  const cases = new DatabaseUseCases({
    execute: async (operation: string, payload: Record<string, unknown>) => {
      if (operation === 'db.tree') {
        const path = (payload['path'] as string[]).join('/');
        asked.push(path);
        if (options.failing) throw new Error('lost');
        return { nodes: tree[path] ?? [] };
      }
      if (operation === 'db.describe') return described;
      return {};
    },
  } as never);
  const section = {
    cases: async () => cases,
    state: { workspaceId: () => 'w' },
    quoteStyle: () => ({
      quoteOpen: '"',
      quoteClose: '"',
      keywords: ['select'],
      functions: ['count'],
    }),
    tabs: { open: (tab: unknown) => void opened.push(tab) },
  } as unknown as DbSection & { schema: SchemaCache };
  section.schema = new SchemaCache(section);
  const runner = {
    connection: () => ({ id: 'c1' }),
    open: async () => options.open !== false,
    session: 'editor:1',
    server: () => ({ database: 'shop' }),
  } as unknown as SqlRunner;
  const source = assistFor(section, runner, () => [
    { name: 'mine', description: 'Mine', text: 'SELECT ${column} FROM mine' },
  ]);
  return { section, source, asked, opened };
}

describe('the schema the SQL editor knows', () => {
  it('finds the tables of its database once, and reads a table when it is needed', async () => {
    const { source, asked, section } = fixture();
    const suggestions = await source.complete('SELECT o. FROM orders o', 9);
    expect(suggestions.map((each) => each.apply)).toEqual(['id', 'user_id', '""']);
    expect(asked).not.toContain('other');
    expect(asked).not.toContain('shop/roles');
    await source.complete('SELECT * FROM ', 14);
    expect(asked.filter((path) => path === '')).toHaveLength(1);
    expect(await source.describe('orders')).toBe(
      'public.orders\n  id  int4\n  user_id  int4\n    ',
    );
    expect(await source.describe('nothing')).toBeUndefined();
    source.open('totals');
    source.open('nothing');
    await new Promise((done) => setTimeout(done));
    section.schema.clear('c1');
    await source.complete('SELECT * FROM ', 14);
    expect(asked.filter((path) => path === '')).toHaveLength(2);
    expect(await source.complete('SELECT 1 -- ', 12)).toEqual([]);
    expect(source.templates().map((template) => template.name)).toContain('mine');
  });

  it('opens a table by its name, and knows nothing when its session does not open', async () => {
    const { source, opened } = fixture();
    source.open('orders');
    await new Promise((done) => setTimeout(done));
    expect(opened).toEqual([
      {
        kind: 'object',
        connection: 'c1',
        title: 'orders',
        path: ['shop', 'schemas', 'public', 'tables', 'orders'],
      },
    ]);
    const closed = fixture({ open: false });
    expect(await closed.source.complete('SELECT * FROM ', 14)).toEqual([]);
  });

  it('knows no table when the tree cannot be read', async () => {
    const { source } = fixture({ failing: true });
    expect(await source.complete('SELECT * FROM ', 14)).toEqual([]);
  });
});

describe('the SQL assistance of the editor', () => {
  const offers: SqlAssistSource = {
    complete: async (statement) =>
      statement.includes('FROM')
        ? [
            { label: 'orders', apply: 'orders', type: 'table', detail: 'shop' },
            { label: 'o.id = u.id', apply: 'o.id = u.id', type: 'join' },
          ]
        : [],
    describe: async (word) => (word === 'orders' ? 'shop.orders' : undefined),
    open: (word) => void opened.push(word),
    templates: () => [
      { name: 'scount', description: 'Count', text: 'SELECT COUNT(*) FROM ${table}' },
    ],
  };
  const opened: string[] = [];

  async function complete(doc: string, explicit = false) {
    const state = EditorState.create({ doc, extensions: [sqlAssist(offers)] });
    const [source] = state.languageDataAt<
      (context: CompletionContext) => Promise<CompletionResult | null>
    >('autocomplete', doc.length);
    return source(new CompletionContext(state, doc.length, explicit));
  }

  it('offers the schema and templates for the statement at the cursor', async () => {
    const result = await complete('SELECT 1; SELECT * FROM o');
    expect(result?.options.map((option) => option.label)).toEqual(['orders', 'o.id = u.id']);
    expect(result?.from).toBe('SELECT 1; SELECT * FROM '.length);
    const templates = await complete('sco');
    expect(templates?.options.map((option) => option.label)).toEqual(['scount']);
    expect(await complete('SELECT 1 ')).toBeNull();
    expect((await complete('SELECT 1 ', true))?.options).toEqual([]);
  });

  function editor(doc: string) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [sqlAssist(offers)],
      }),
      parent: document.body,
    });
    return view;
  }
  const press = (view: EditorView, key: string) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor');

  it('writes a template with Tab, and leaves Tab alone otherwise', () => {
    const view = editor('scount');
    expect(completionStatus(view.state)).toBeNull();
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('SELECT COUNT(*) FROM table');
    const plain = editor('nothing');
    expect(press(plain, 'Tab')).toBe(false);
    view.destroy();
    plain.destroy();
  });

  it('opens the object under the cursor with F4', () => {
    const view = editor('SELECT * FROM "orders"');
    view.dispatch({ selection: { anchor: 17 } });
    expect(press(view, 'F4')).toBe(true);
    expect(opened).toContain('orders');
    view.dispatch({ selection: { anchor: 14 } });
    const before = opened.length;
    press(view, 'F4');
    expect(opened.length).toBeGreaterThanOrEqual(before);
    view.destroy();
  });
  it('takes an open suggestion with Tab, and opens a name with Ctrl+click', async () => {
    const doc = 'SELECT * FROM o';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [sqlAssist(offers), autocompletion()],
      }),
      parent: document.body,
    });
    startCompletion(view);
    for (let i = 0; i < 20 && completionStatus(view.state) !== 'active'; i++)
      await new Promise((done) => setTimeout(done, 20));
    await new Promise((done) => setTimeout(done, 100));
    expect(press(view, 'Tab')).toBe(true);
    expect(['SELECT * FROM orders', 'SELECT * FROM o.id = u.id']).toContain(
      view.state.doc.toString(),
    );
    const plain = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(plain);
    const ctrl = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true });
    view.contentDOM.dispatchEvent(ctrl);
    view.destroy();
  });
});
