import { describe, expect, it } from 'vitest';
import { node, startDbPanel } from '../testing/db-panel';
import { buttons, typeCode } from '../testing/controls';

const columns = [
  { name: 'day', typeName: 'date', kind: 'date' },
  { name: 'orders', typeName: 'int8', kind: 'integer' },
];
const rows = [
  ['2024-01-01', 3],
  ['2024-01-02', 5],
];

function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  const classification = {
    kind: 'read',
    missingWhere: false,
    truncate: false,
    drop: [],
    drops: false,
  };
  return text
    ? { statements: [{ text, start: 0, end: text.length, line: 1, classification }], current: 0 }
    : { statements: [], current: null };
}

describe('charts of results', () => {
  it('chart a query in its tab and keep the chart with the saved script', async () => {
    const panel = await startDbPanel({
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': split,
        'db.execute': () => ({ columns, rows, elapsedMs: 1 }),
      },
    });
    typeCode(
      panel.root().querySelector('.cm-content[aria-label="SQL script"]')!,
      'select day, count(*) as orders from t group by day',
    );
    await panel.settle();
    await panel.click(/^▶ Run$/);
    const views = panel.root().querySelector<HTMLElement>('[aria-label="Result views"]')!;
    await panel.click('Chart', views);
    expect(panel.root().querySelectorAll('app-result-chart path.rc-line')).toHaveLength(1);
    const type = panel.control('Chart') as HTMLSelectElement;
    type.value = 'bar';
    type.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.root().querySelectorAll('app-result-chart rect.rc-shape')).toHaveLength(2);
    const draft = panel.section().tabs.draft('s1');
    expect(draft.charts).toEqual({
      'select day, count(*) as orders from t group by day': expect.objectContaining({
        type: 'bar',
        x: 'day',
      }),
    });
    await panel.click(/^Save/);
    const dialog = panel.dialog();
    const name = dialog.querySelector('input')!;
    name.value = 'Daily';
    name.dispatchEvent(new Event('input'));
    await panel.settle();
    buttons(dialog, 'Save')[0].click();
    await panel.settle();
    const script = panel.api.documentsStore.find((document) => document.kind === 'sql-script')!;
    expect((script.value as { charts: Record<string, { type: string }> }).charts).toEqual({
      'select day, count(*) as orders from t group by day': expect.objectContaining({
        type: 'bar',
      }),
    });
    // Opened again, the script brings its chart.
    panel.section().openScript(script.id);
    await panel.settle();
    const opened = panel.section().tabs.tabs().at(-1)!;
    expect(panel.section().tabs.draft(opened.id).charts).toEqual(
      expect.objectContaining({
        'select day, count(*) as orders from t group by day': expect.objectContaining({
          type: 'bar',
        }),
      }),
    );
  });

  it('chart the rows a table shows in its data', async () => {
    const path = ['shop', 'schemas', 'public', 'tables', 'orders'];
    const panel = await startDbPanel({
      tree: { '': [node('database', 'shop')] },
      tabs: [{ id: 'o1', kind: 'object', title: 'orders', path }],
      responses: {
        'db.describe': () => ({
          kind: 'table',
          name: 'public.orders',
          properties: [],
          sections: [],
        }),
        'db.execute': () => ({ columns, rows, elapsedMs: 1 }),
      },
    });
    await panel.settle(20);
    await panel.click('Chart');
    expect(panel.root().querySelector('app-result-chart')).not.toBeNull();
    const type = panel.control('Chart') as HTMLSelectElement;
    type.value = 'area';
    type.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(panel.root().querySelectorAll('app-result-chart path.rc-area')).toHaveLength(1);
    await panel.click('Chart');
    expect(panel.root().querySelector('app-result-chart')).toBeNull();
  });
});
