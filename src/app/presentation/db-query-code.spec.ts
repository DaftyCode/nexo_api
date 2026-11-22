import { afterEach, describe, expect, it } from 'vitest';
import { codeText, codeView, typeCode } from '../testing/controls';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  return {
    statements: [
      {
        text,
        start: 0,
        end: text.length,
        line: 1,
        classification: {
          kind: 'read',
          missingWhere: false,
          truncate: false,
          drop: [],
          drops: false,
        },
      },
    ],
    current: 0,
  };
}

async function open() {
  const panel = await startDbPanel({
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: {
      'db.split': split,
      'db.execute': () => ({ columns: [{ name: 'n' }], rows: [[1]], elapsedMs: 1 }),
    },
  });
  panel.api.calls.length = 0;
  return panel;
}
const editor = (panel: DbPanelTest) =>
  panel.root().querySelector('.cm-content[aria-label="SQL script"]')!;
const written: string[] = [];

describe('the code of a statement', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    written.length = 0;
  });

  it('shows a program of the statement at the cursor, to copy, as a string too, or download', async () => {
    const panel = await open();
    (await panel.section().cases()).assist.remember({ id: '7' });
    typeCode(editor(panel), "SELECT 1;\nSELECT * FROM t WHERE id = :id AND n = 'it''s'");
    const view = codeView(editor(panel));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await panel.settle();
    await panel.click(/^Code$/);
    const dialog = panel.dialog('Code');
    expect(dialog.textContent).toContain('DATABASE_URL');
    const program = codeText(dialog, 'Code');
    expect(program).toContain("import pg from 'pg';");
    expect(program).toContain('WHERE id = $1');
    expect(program).toContain('client.query(sql, [7])');
    expect(program).not.toContain('SELECT 1;');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    await panel.click(/^Copy$/, dialog);
    expect(written[0]).toBe(program);
    expect(dialog.textContent).toContain('Copied');
    const language = panel.control('Language', dialog) as HTMLSelectElement;
    language.value = 'python';
    language.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(codeText(dialog, 'Code')).toContain('import psycopg');
    await panel.click('Copy as string', dialog);
    expect(written[1]).toBe("\"SELECT * FROM t WHERE id = :id AND n = 'it''s'\"");
    language.value = 'cli';
    language.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(codeText(dialog, 'Code')).toContain('psql "$DATABASE_URL"');
    await panel.click('Download', dialog);
    await panel.click('Close', dialog);
    expect(() => panel.dialog('Code')).toThrow();
  });

  it('says when a language has no usual library for the engine', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'files', database: '/data' },
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    });
    typeCode(editor(panel), 'SELECT 1');
    await panel.settle();
    await panel.click(/^Code$/);
    const dialog = panel.dialog('Code');
    const language = panel.control('Language', dialog) as HTMLSelectElement;
    language.value = 'php';
    language.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      'PHP has no usual library for DuckDB',
    );
    expect((panel.buttons(/^Copy$/, dialog)[0] as HTMLButtonElement).disabled).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await panel.settle();
    expect(() => panel.dialog('Code')).toThrow();
  });

  it('puts a statement pasted from code in the editor, and says when nothing is at the cursor', async () => {
    const panel = await open();
    typeCode(editor(panel), '  ');
    await panel.settle();
    await panel.click(/^Code$/);
    expect(panel.text()).toContain('No statement at the cursor');
    typeCode(editor(panel), 'SELECT 2');
    await panel.settle();
    await panel.click(/^Code$/);
    const dialog = panel.dialog('Code');
    const pasted = dialog.querySelector('textarea')!;
    pasted.value = 'String sql = "SELECT *\\n" +\n  "FROM orders";';
    pasted.dispatchEvent(new Event('input'));
    await panel.settle();
    expect(dialog.querySelector('pre')?.textContent).toBe('SELECT *\nFROM orders');
    await panel.click('Put it in the editor', dialog);
    expect(codeText(panel.root(), 'SQL script')).toContain('SELECT *\nFROM orders');
  });

  it('shows the code of a result tab, without pasting', async () => {
    const panel = await open();
    typeCode(editor(panel), 'SELECT n FROM t');
    await panel.settle();
    await panel.click(/^▶ Run$/);
    const toolbar = panel.root().querySelector('.db-result-toolbar')!;
    await panel.click(/^Code$/, toolbar);
    const dialog = panel.dialog('Code');
    expect(codeText(dialog, 'Code')).toContain("'SELECT n FROM t'");
    expect(dialog.querySelector('textarea')).toBeNull();
  });
});
