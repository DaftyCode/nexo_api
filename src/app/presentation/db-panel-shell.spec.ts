import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

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

async function start(tabs: Parameters<typeof startDbPanel>[0]['tabs']) {
  const panel = await startDbPanel({
    tabs,
    responses: {
      'db.split': split,
      'db.execute': (payload: Record<string, unknown>) =>
        String(payload['sql']).startsWith('fail')
          ? (() => {
              throw new Error('bad statement');
            })()
          : {
              columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
              rows: [[1]],
              elapsedMs: 1,
              notices: [{ severity: 'info', message: 'hello' }],
            },
    },
  });
  for (const [id, sql, error] of [
    ['h1', 'select alpha', ''],
    ['h2', 'select beta', 'it failed'],
  ] as const)
    panel.api.documentsStore.push({
      id,
      workspace_id: 'local',
      kind: 'sql-history',
      name: id,
      revision: 1,
      updated_at: 0,
      value: {
        connectionId: 'c1',
        sql,
        startedAt: 1,
        durationMs: 2,
        ...(error ? { error } : { rows: 3 }),
      },
    });
  await panel.state.refresh();
  await panel.settle();
  return panel;
}
const consoleInput = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLTextAreaElement>('[aria-label="Statement to run"]')!;
async function type(panel: DbPanelTest, text: string, key = 'Enter') {
  const input = consoleInput(panel);
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  for (let i = 0; i < 5; i++) {
    await new Promise((done) => setTimeout(done, 10));
    await panel.settle();
  }
}

describe('the shell of the database section', () => {
  it('runs statements in the console, recalls them with the arrows and clears its lines', async () => {
    const panel = await start([{ id: 'k1', kind: 'console', title: 'Console' }]);
    await type(panel, 'select 1');
    await type(panel, 'fail now');
    // A failure asks what to do, as in a script.
    await panel.click(/^Stop$/, panel.dialog());
    await type(panel, 'select 1');
    expect(panel.text()).toContain('bad statement');
    expect(panel.text()).toContain('hello');
    await type(panel, '', 'ArrowUp');
    expect(consoleInput(panel).value).toBe('select 1');
    await type(panel, consoleInput(panel).value, 'ArrowUp');
    expect(consoleInput(panel).value).toBe('fail now');
    await type(panel, consoleInput(panel).value, 'ArrowDown');
    await type(panel, consoleInput(panel).value, 'ArrowDown');
    expect(consoleInput(panel).value).toBe('');
    await type(panel, '', 'Enter');
    await panel.click(/^Clear$/);
    expect(panel.text()).not.toContain('bad statement');
  });

  it('lists the history of the connection, filtered, and puts an entry in the editor', async () => {
    const panel = await start([{ id: 's1', kind: 'sql', title: 'SQL' }]);
    await panel.click(/^History$/);
    const history = panel.root().querySelector<HTMLElement>('aside[aria-label="History"]')!;
    expect(history.textContent).toContain('Failed');
    expect(history.textContent).toContain('select alpha');
    const filter = history.querySelector<HTMLInputElement>('input');
    if (filter) {
      filter.value = 'beta';
      filter.dispatchEvent(new Event('input'));
      await panel.settle();
      expect(history.textContent).not.toContain('select alpha');
    }
    await panel.click('select beta', history);
    expect(panel.section().tabs.draft('s1').text).toBe('select beta');
    await panel.click('Close the history');
  });

  it('moves between the editor tabs with the arrows, resizes and warns before leaving', async () => {
    const panel = await start([
      { id: 's1', kind: 'sql', title: 'One' },
      { id: 's2', kind: 'sql', title: 'Two' },
    ]);
    const tab = panel.root().querySelector<HTMLElement>('[data-tab="s2"]')!;
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await panel.settle();
    expect(panel.section().tabs.activeId()).toBe('s1');
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await panel.settle();
    panel.fixture.debugElement.query(By.css('app-splitter')).triggerEventHandler('resized', 10);
    await panel.settle();
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', ctrlKey: true, bubbles: true }));
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true }),
    );
    await panel.settle();
    expect(panel.section().searching()).toBe(false);
  });
});
