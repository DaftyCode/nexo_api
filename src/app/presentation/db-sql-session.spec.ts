import { describe, expect, it } from 'vitest';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';
import { typeCode } from '../testing/controls';

function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  return {
    statements: text
      ? [
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
        ]
      : [],
    current: text ? 0 : null,
  };
}
async function run(panel: DbPanelTest, sql: string) {
  typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, sql);
  await panel.settle();
  await panel.click(/^▶ Run$/);
}

describe('the session of a SQL tab', () => {
  it('says why it could not open, and keeps the most result tabs chosen', async () => {
    let failing = true;
    const panel = await startDbPanel({
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': split,
        'db.connect': () => {
          if (failing) throw new Error('password authentication failed');
          return { serverVersion: '18', database: 'shop', tls: false };
        },
        'db.execute': () => ({
          columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
          rows: [[1]],
          elapsedMs: 1,
        }),
      },
    });
    await run(panel, 'select 1');
    await panel.click(/^Messages/);
    expect(panel.text()).toContain('password authentication failed');
    failing = false;
    await run(panel, 'select 1');
    const most = panel.control('Most result tabs') as HTMLInputElement;
    most.value = '3';
    most.dispatchEvent(new Event('input'));
    most.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.section().runner('s1').maxResults).toBe(3);
  });

  it('cancels the statement that runs', async () => {
    let release: (value: unknown) => void = () => undefined;
    const panel = await startDbPanel({
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': split,
        'db.cancel': () => {
          release({ columns: [], rows: [], elapsedMs: 1 });
          return {};
        },
        'db.execute': () => new Promise((done) => (release = done)),
      },
    });
    typeCode(
      panel.root().querySelector('.cm-content[aria-label="SQL script"]')!,
      'select pg_sleep(60)',
    );
    await panel.settle();
    panel.buttons(/^▶ Run$/)[0].click();
    for (let i = 0; i < 10 && !panel.calls('db.execute').length; i++) await panel.settle();
    await panel.click(/^Cancel$/);
    expect(panel.calls('db.cancel')[0]).toMatchObject({
      statement: panel.calls('db.execute')[0]['statement'],
    });
    await panel.section().runner('s1').cancel();
  });

  it('says the startup queries that failed and a connection that opened again', async () => {
    let answer: Record<string, unknown> = { reconnected: true };
    const panel = await startDbPanel({
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': split,
        'db.connect': () => ({
          serverVersion: '18',
          tls: false,
          startup: [{ sql: 'SET x = 1', error: 'unknown setting' }],
        }),
        'db.execute': () => ({
          columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
          rows: [[1]],
          elapsedMs: 1,
          ...answer,
        }),
      },
    });
    await run(panel, 'select 1');
    await panel.click(/^Messages/);
    expect(panel.text()).toContain('The startup query «SET x = 1» failed: unknown setting');
    expect(panel.text()).toContain('The connection had closed and was opened again.');
    answer = { reconnected: true, transactionLost: true };
    await run(panel, 'select 2');
    await panel.click(/^Messages/);
    expect(panel.text()).toContain('its open transaction was lost');
  });
});
