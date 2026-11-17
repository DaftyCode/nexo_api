import { describe, expect, it } from 'vitest';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';
import { codeView, typeCode } from '../testing/controls';

function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  const statements: unknown[] = [];
  let start = 0;
  for (const part of script.split(';')) {
    const text = part.trim();
    if (text) {
      const from = start + part.indexOf(text);
      const verb = text.split(/\s/)[0].toLowerCase();
      statements.push({
        text,
        start: from,
        end: from + text.length,
        line: 1,
        classification: {
          kind: verb === 'select' ? 'read' : verb === 'drop' ? 'structure' : 'write',
          missingWhere: verb === 'delete' && !/where/i.test(text),
          truncate: false,
          drop: verb === 'drop' ? [text.split(/\s/).at(-1)] : [],
          drops: verb === 'drop',
        },
      });
    }
    start += part.length + 1;
  }
  const offset = Number(payload['offset'] ?? -1);
  return { statements, current: offset < 0 ? null : 0 };
}
const columns = [
  {
    name: 'city',
    typeName: 'text',
    kind: 'text',
    origin: { schema: 'shop', table: 'orders', column: 'city' },
  },
];

async function start() {
  return startDbPanel({
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: {
      'db.split': split,
      'db.execute': (payload: Record<string, unknown>) =>
        String(payload['sql']).includes('nexo_count')
          ? { columns: [], rows: [['Lugo', 4]], cursor: 'g', elapsedMs: 1 }
          : { columns, rows: [['Lugo'], ['Vigo']], elapsedMs: 1 },
    },
  });
}
const editor = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLElement>('.cm-content[aria-label="SQL script"]')!;
async function write(panel: DbPanelTest, text: string) {
  typeCode(editor(panel), text);
  await panel.settle();
}
const sqls = (panel: DbPanelTest) =>
  panel.calls('db.execute').map((payload) => String(payload['sql']));

describe('the SQL runner, at its edges', () => {
  it('runs only the statements selected', async () => {
    const panel = await start();
    await write(panel, 'select 1; select 2');
    codeView(editor(panel)).dispatch({ selection: { anchor: 10, head: 18 } });
    await panel.settle();
    await panel.click(/^▶ Run$/);
    expect(sqls(panel)).toEqual(['select 2']);
  });

  it('runs nothing that was not confirmed, and sends the names typed for a DROP', async () => {
    const panel = await start();
    await write(panel, 'delete from orders');
    await panel.click(/^▶ Run$/);
    await panel.click('Cancel', panel.dialog());
    expect(sqls(panel)).toEqual([]);
    await write(panel, 'drop table orders');
    await panel.click(/^▶ Run$/);
    const dialog = panel.dialog();
    const typed = [...dialog.querySelectorAll<HTMLInputElement>('input')].at(-1)!;
    typed.value = 'orders';
    typed.dispatchEvent(new Event('input'));
    await panel.settle();
    await panel.click(/^Run$/, dialog);
    expect(panel.calls('db.execute')[0]).toMatchObject({
      sql: 'drop table orders',
      confirmName: 'orders',
    });
  });

  it('says which client variable is missing', async () => {
    const panel = await start();
    await write(panel, 'select ${missing}');
    await panel.click(/^▶ Run$/);
    await panel.click(/^Messages/);
    expect(panel.text()).toContain('missing');
    expect(sqls(panel)).toEqual([]);
  });

  it('groups the rows of the whole table on the server', async () => {
    const panel = await start();
    await write(panel, 'select city from shop.orders');
    await panel.click(/^▶ Run$/);
    await panel.click('Grid tools');
    const menu = panel.root().querySelector<HTMLElement>('[role="menu"]')!;
    await panel.click('Grouping', menu);
    const grouping = panel.root().querySelector<HTMLElement>('.grid-panel')!;
    await panel.click('city', grouping);
    await panel.click('Group the whole table on the server', grouping);
    expect(sqls(panel).at(-1)).toContain('nexo_count');
    expect(grouping.textContent).toContain('4');
    expect(panel.calls('db.close')).toEqual([expect.objectContaining({ cursor: 'g' })]);
  });
});
