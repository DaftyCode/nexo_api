import { describe, expect, it } from 'vitest';
import { DbPanelTest, driverHello, startDbPanel } from '../testing/db-panel';
import { codeView, typeCode } from '../testing/controls';

function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  if (script.includes('broken')) throw new Error('cannot split');
  const text = script.trim();
  const write = /^(update|delete|insert)/i.test(text);
  return {
    statements: text
      ? [
          {
            text,
            start: 0,
            end: text.length,
            line: 1,
            classification: {
              kind: write ? 'write' : 'read',
              missingWhere: false,
              truncate: false,
              drop: [],
              drops: false,
            },
          },
        ]
      : [],
    current: text && payload['offset'] !== undefined ? 0 : null,
  };
}
const plan = {
  mode: 'estimated',
  nodes: [{ operation: 'Seq Scan', object: 'orders', estimatedRows: 10 }],
  format: 'json',
  original: '[]',
};

async function start() {
  return startDbPanel({
    hello: driverHello({ explain: ['estimated', 'actual'] }),
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: {
      'db.split': split,
      'db.explain': () => plan,
      'db.execute': () => ({
        columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
        rows: [[1]],
        elapsedMs: 1,
      }),
    },
  });
}
const editor = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLElement>('.cm-content[aria-label="SQL script"]')!;
async function write(panel: DbPanelTest, text: string) {
  typeCode(editor(panel), text);
  await panel.settle();
}
const explain = async (panel: DbPanelTest) => {
  panel.buttons(/^Explain$/)[0].click();
  await panel.settle();
};
const messages = async (panel: DbPanelTest) => {
  await panel.click(/^Messages/);
  return panel.text();
};

describe('the plans of a SQL tab, at their edges', () => {
  it('explains the selection, and says when there is nothing to explain', async () => {
    const panel = await start();
    await write(panel, 'select 1; select 2');
    codeView(editor(panel)).dispatch({ selection: { anchor: 10, head: 18 } });
    await panel.settle();
    await explain(panel);
    expect(panel.calls('db.explain')[0]).toMatchObject({ sql: 'select 2' });
    await write(panel, '   ');
    await explain(panel);
    expect(await messages(panel)).toContain('Nothing to explain at the cursor');
    await write(panel, 'broken');
    await explain(panel);
    expect(await messages(panel)).toContain('cannot split');
  });

  it('runs nothing when the parameters are not given', async () => {
    const panel = await start();
    await write(panel, 'select :id');
    await explain(panel);
    await panel.click('Cancel', panel.dialog('The parameters of the statement'));
    expect(panel.calls('db.explain')).toEqual([]);
    expect(await messages(panel)).toContain('Not run: its parameters were not given');
  });

  it('explains a result again, and does not measure a change that was not confirmed', async () => {
    const panel = await start();
    await write(panel, 'select 3');
    await panel.click(/^▶ Run$/);
    const toolbar = panel.root().querySelector<HTMLElement>('.db-result-toolbar[role="toolbar"]')!;
    await panel.click(/^Explain$/, toolbar);
    expect(panel.calls('db.explain')).toHaveLength(1);
    await write(panel, 'update t set a = 1');
    await explain(panel);
    const measure = panel.buttons('Run it to measure')[0];
    measure?.click();
    await panel.settle();
    const confirm = panel.root().querySelector<HTMLElement>('[role="dialog"]');
    if (confirm) await panel.click('Cancel', confirm);
    expect(panel.calls('db.explain').every((payload) => payload['mode'] !== 'actual')).toBe(true);
  });
});
