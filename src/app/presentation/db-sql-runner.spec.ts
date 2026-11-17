import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../application/ports';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';
import { typeCode } from '../testing/controls';

/** Splits as the backend does in these tests: by semicolons, classified by their verb. */
function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  const statements: unknown[] = [];
  let start = 0;
  for (const part of script.split(';')) {
    const text = part.trim();
    if (text) {
      const from = start + part.indexOf(text);
      statements.push({
        text,
        start: from,
        end: from + text.length,
        line: script.slice(0, from).split('\n').length,
        classification: {
          kind: /^select/i.test(text) ? 'read' : 'write',
          missingWhere: false,
          truncate: false,
          drop: [],
          drops: false,
        },
      });
    }
    start += part.length + 1;
  }
  const offset = Number(payload['offset'] ?? -1);
  const current = statements.findIndex((statement) => (statement as { end: number }).end >= offset);
  return { statements, current: offset < 0 || current < 0 ? null : current };
}

function execute(payload: Record<string, unknown>) {
  const sql = String(payload['sql']);
  if (sql === 'select fail')
    throw new ApiFailure('syntax error at "fail"', 'database.error', 400, { line: 1, column: 8 });
  if (sql === 'select slow') throw new ApiFailure('cancelled', 'database.cancelled', 400);
  if (sql.includes('nexo_count'))
    return {
      columns: [],
      rows: [
        ['a', 2],
        ['b', 1],
      ],
      cursor: 'g',
      elapsedMs: 1,
    };
  if (/^update/i.test(sql)) return { columns: [], rows: [], affected: 3, elapsedMs: 1 };
  if (/^create/i.test(sql)) return { columns: [], rows: [], affected: null, elapsedMs: 1 };
  return {
    columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
    rows: [[1]],
    elapsedMs: 1,
    ...(sql === 'select warn'
      ? {
          notices: [
            { severity: 'warning', message: 'careful' },
            { severity: 'info', message: 'just so you know' },
          ],
        }
      : {}),
  };
}

async function start() {
  const panel = await startDbPanel({
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: { 'db.split': split, 'db.execute': execute, 'db.cancel': () => ({}) },
  });
  panel.api.documentsStore.push({
    id: 'lib',
    workspace_id: 'local',
    kind: 'sql-script',
    name: 'Lib',
    revision: 1,
    updated_at: 0,
    value: { connectionId: 'c1', sql: 'select 3' },
  });
  await panel.state.refresh();
  await panel.settle();
  return panel;
}

async function script(panel: DbPanelTest, text: string) {
  typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, text);
  await panel.settle();
  await panel.click(/^Script$/);
}
const sqls = (panel: DbPanelTest) =>
  panel.calls('db.execute').map((payload) => String(payload['sql']));
async function messages(panel: DbPanelTest) {
  await panel.click(/^Messages/);
  return panel.text();
}

describe('the SQL runner', () => {
  it('runs client commands and variables, and includes a saved script', async () => {
    const panel = await start();
    await script(
      panel,
      "@set table = 'orders'\n@echo hello\nselect ${table};\n@include Lib\n@unset table\nselect ${table}",
    );
    expect(sqls(panel)).toEqual(['select orders', 'select 3']);
    const text = await messages(panel);
    expect(text).toContain('hello');
    expect(text).toMatch(/table/);
  });

  it('stops at a wrong command, a missing script or a wrong export', async () => {
    const panel = await start();
    await script(panel, '@nothing\nselect 1');
    await script(panel, '@include Missing\nselect 1');
    await script(panel, '@export pdf\nselect 1');
    expect(sqls(panel)).toEqual([]);
    const text = await messages(panel);
    expect(text).toContain('@nothing');
    expect(text).toContain('Missing');
    expect(text).toContain('pdf');
  });

  it('sends the query after @export to the export wizard instead of running it', async () => {
    const panel = await start();
    await script(panel, '@export json\nselect 1');
    expect(sqls(panel)).toEqual([]);
    expect(panel.section().transferRequest()).toMatchObject({
      kind: 'export',
      format: 'json',
      sql: 'select 1',
    });
  });

  it('asks what to do after a failure: stop, go on, or remember to go on', async () => {
    const panel = await start();
    await script(panel, 'select 1; select fail; select 2');
    const dialog = panel.dialog();
    expect(dialog.textContent).toContain('A statement failed');
    await panel.click(/^Stop$/, dialog);
    expect(sqls(panel)).toEqual(['select 1', 'select fail']);

    await script(panel, 'select fail; select 2');
    const again = panel.dialog();
    (panel.control('Remember my choice', again) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Continue$/, again);
    expect(sqls(panel).slice(-2)).toEqual(['select fail', 'select 2']);

    await script(panel, 'select fail; select 4');
    expect(sqls(panel).slice(-2)).toEqual(['select fail', 'select 4']);
    expect(panel.root().querySelector('[role="dialog"]')).toBeNull();
    const text = await messages(panel);
    expect(text).toContain('syntax error');
  });

  it('ignores the next failures of one run when asked', async () => {
    const panel = await start();
    await script(panel, 'select fail; select fail; select 5');
    await panel.click('Ignore the next failures', panel.dialog());
    expect(sqls(panel)).toEqual(['select fail', 'select fail', 'select 5']);
  });

  it('stops a script when a statement is cancelled', async () => {
    const panel = await start();
    await script(panel, 'select slow; select 6');
    expect(sqls(panel)).toEqual(['select slow']);
    expect(panel.root().querySelector('[role="dialog"]')).toBeNull();
  });

  it('says the rows changed, what ran, and the notices of the server', async () => {
    const panel = await start();
    await script(panel, 'update t set a = 1; create table x (a int); select warn');
    const text = await messages(panel);
    expect(text).toContain('3 rows changed');
    expect(text).toContain('careful');
    expect(text).toContain('just so you know');
  });

  it('says there is nothing to run at the cursor of an empty editor', async () => {
    const panel = await start();
    await panel.click(/^▶ Run$/);
    expect(await messages(panel)).toContain('Nothing to run at the cursor');
  });

  it('asks the parameters of a statement and binds them, or runs nothing', async () => {
    const panel = await start();
    await script(panel, 'select :name, :n, :none');
    let dialog = panel.dialog('The parameters of the statement');
    await panel.click('Cancel', dialog);
    expect(sqls(panel)).toEqual([]);
    await script(panel, 'select :name, :n, :none');
    dialog = panel.dialog('The parameters of the statement');
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input')];
    const selects = [...dialog.querySelectorAll<HTMLSelectElement>('select')];
    inputs[0].value = "O'Brien";
    inputs[1].value = '7';
    selects[1].value = 'number';
    selects[2].value = 'null';
    for (const control of [...inputs, ...selects]) {
      control.dispatchEvent(new Event('input'));
      control.dispatchEvent(new Event('change'));
    }
    await panel.settle();
    await panel.click(/^Run$/, dialog);
    const [run] = panel.calls('db.execute');
    expect(run['sql']).toBe('select $1, $2, $3');
    expect(run['params']).toEqual(["O'Brien", 7, null]);
  });

  it('runs a result again into its own tab', async () => {
    const panel = await start();
    await script(panel, 'select 7');
    await panel.click('Run again');
    expect(sqls(panel)).toEqual(['select 7', 'select 7']);
  });
});
