import { EditorView, runScopeHandlers } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../application/ports';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';
import { codeView, typeCode } from '../testing/controls';

function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  const text = script.trim();
  return {
    statements: text
      ? [
          {
            text,
            start: script.indexOf(text),
            end: script.indexOf(text) + text.length,
            line: 1,
            classification: {
              kind: 'read',
              missingWhere: false,
              truncate: false,
              drop: [],
              drops: false,
            },
          },
        ]
      : [],
    current: text ? 0 : null,
  };
}

async function start() {
  const panel = await startDbPanel({
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: {
      'db.split': split,
      'db.execute': (payload: Record<string, unknown>) => {
        if (payload['sql'] === 'select oops')
          throw new ApiFailure('syntax error', 'database.error', 400, { line: 1, column: 8 });
        return { columns: [], rows: [], affected: 0, elapsedMs: 1 };
      },
      'db.cancel': () => ({}),
    },
  });
  for (const [id, sql, startedAt] of [
    ['h1', 'select old', 1],
    ['h2', 'select newer', 2],
  ] as const)
    panel.api.documentsStore.push({
      id,
      workspace_id: 'local',
      kind: 'sql-history',
      name: id,
      revision: 1,
      updated_at: 0,
      value: { connectionId: 'c1', sql, startedAt, durationMs: 1 },
    });
  await panel.state.refresh();
  await panel.settle();
  return panel;
}
const editor = (panel: DbPanelTest): EditorView =>
  codeView(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!);
async function keys(panel: DbPanelTest, key: string, extra: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { key, ...extra });
  if (/^[a-zA-Z]$/.test(key))
    Object.defineProperty(event, 'keyCode', { value: key.toUpperCase().charCodeAt(0) });
  runScopeHandlers(editor(panel), event, 'editor');
  await panel.settle();
}
const text = (panel: DbPanelTest) => editor(panel).state.doc.toString();

describe('the tools of a SQL tab', () => {
  it('formats the statement at the cursor, and changes the case of the selection', async () => {
    const panel = await start();
    typeCode(
      panel.root().querySelector('.cm-content[aria-label="SQL script"]')!,
      'select 1;\nselect a,b from t where a>1',
    );
    editor(panel).dispatch({ selection: { anchor: 15 } });
    await keys(panel, 'F', { ctrlKey: true, shiftKey: true });
    expect(text(panel)).toMatch(/^select 1;\nSELECT/);
    expect(text(panel)).toContain('FROM t');
    editor(panel).dispatch({ selection: { anchor: 0, head: 6 } });
    await keys(panel, 'X', { ctrlKey: true, shiftKey: true });
    expect(text(panel).startsWith('SELECT 1;')).toBe(true);
    editor(panel).dispatch({ selection: { anchor: 0, head: 6 } });
    await keys(panel, 'Y', { ctrlKey: true, shiftKey: true });
    expect(text(panel).startsWith('select 1;')).toBe(true);
  });

  it('walks the history of the connection with Ctrl+Alt+arrows', async () => {
    const panel = await start();
    await keys(panel, 'ArrowUp', { ctrlKey: true, altKey: true });
    const first = text(panel);
    await keys(panel, 'ArrowUp', { ctrlKey: true, altKey: true });
    const second = text(panel);
    expect([first, second].sort()).toEqual(['select newer', 'select old']);
    await keys(panel, 'ArrowUp', { ctrlKey: true, altKey: true });
    expect(text(panel)).toBe(second);
    await keys(panel, 'ArrowDown', { ctrlKey: true, altKey: true });
    expect(text(panel)).toBe(first);
  });

  it('saves a new script with its folder, then over its document', async () => {
    const panel = await start();
    typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, 'select 1');
    await panel.settle();
    await keys(panel, 's', { ctrlKey: true });
    const dialog = panel.dialog();
    const [name, folder] = [...dialog.querySelectorAll<HTMLInputElement>('input')];
    name.value = 'Totals';
    folder.value = 'Reports';
    for (const input of [name, folder]) input.dispatchEvent(new Event('input'));
    await panel.settle();
    await panel.click(/^Save$/, dialog);
    const saved = panel.api.documentsStore.find((document) => document.kind === 'sql-script')!;
    expect(saved).toMatchObject({ name: 'Totals', value: { sql: 'select 1', folder: 'Reports' } });
    expect(panel.section().tabs.active()?.title).toBe('Totals');

    typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, 'select 2');
    await panel.settle();
    const save = panel.api.save.bind(panel.api);
    let failed = false;
    panel.api.save = async (document) => {
      if (!failed) {
        failed = true;
        throw new ApiFailure('changed', 'conflict', 409);
      }
      return save(document);
    };
    await keys(panel, 's', { ctrlKey: true });
    expect(
      panel.api.documentsStore.find((document) => document.id === saved.id)?.value,
    ).toMatchObject({
      sql: 'select 2',
    });
  });

  it('opens the session on another database and schema', async () => {
    const panel = await start();
    await panel.fill('Database', 'archive');
    await panel.fill('Schema', 'sales');
    await panel.click(/^Use$/);
    expect(panel.calls('db.connect').at(-1)).toMatchObject({ database: 'archive' });
    expect(panel.calls('db.execute').map((payload) => payload['sql'])).toContain(
      'SET search_path TO sales',
    );
  });

  it('goes to the place of an error, cancels and ignores commit without a transaction', async () => {
    const panel = await start();
    typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, 'select oops');
    await panel.settle();
    await keys(panel, 'Enter', { ctrlKey: true });
    await panel.click(/^Messages/);
    await panel.click(/line 1, column 8/i);
    expect(editor(panel).state.selection.main.head).toBe(7);
    await keys(panel, 'k', { ctrlKey: true, altKey: true, shiftKey: true });
    await keys(panel, 'r', { ctrlKey: true, altKey: true, shiftKey: true });
    expect(panel.calls('db.transaction').map((payload) => payload['action'])).not.toContain(
      'commit',
    );
    await keys(panel, '\\', { ctrlKey: true });
    expect(panel.calls('db.execute').length).toBeGreaterThanOrEqual(2);
  });
});
