import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { describe, expect, it } from 'vitest';
import { DbPanelTest, driverHello, startDbPanel } from '../testing/db-panel';

const panels = [
  {
    id: 'sessions',
    title: 'Sessions',
    sql: 'SELECT active',
    chart: 'line',
    unit: 'sessions',
    interval: 5,
  },
  { id: 'size', title: 'Size', sql: 'SELECT size', chart: 'value', unit: 'bytes', interval: 5 },
];

async function dashboardTab() {
  const panel = await startDbPanel({
    hello: driverHello({ methods: ['dashboards'] }),
    responses: {
      'db.dashboards': () => ({ dashboards: panels }),
      'db.dashboard.read': (payload: Record<string, unknown>) => {
        const sql = String(payload['sql']);
        if (sql.startsWith('DELETE')) throw new Error('A panel only reads');
        if (sql === 'SELECT size') return { columns: [{ name: 'size' }], rows: [[2048]] };
        if (sql === 'SELECT active') return { columns: [{ name: 'active' }], rows: [[3]] };
        return { columns: [{ name: 'mine' }], rows: [[7]] };
      },
    },
  });
  await panel.menu('Shop', 'Dashboard');
  await panel.settle(30);
  return panel;
}
const view = (panel: DbPanelTest) => panel.root().querySelector('app-db-dashboard')!;
const titles = (panel: DbPanelTest) =>
  [...view(panel).querySelectorAll('.db-dash-card h3')].map((title) => title.textContent?.trim());
const layout = (panel: DbPanelTest) => panel.section().dashboards.layout('c1');

describe('DbDashboard', () => {
  it('reads the driver’s panels on its own session, and lays them out', async () => {
    const panel = await dashboardTab();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'dashboard', title: 'Dashboard' });
    expect(panel.text()).toContain('Shop · Dashboard');
    expect(panel.calls('db.connect').some((call) => call['session'] === 'dashboard:c1')).toBe(true);
    expect(titles(panel)).toEqual(['Sessions', 'Size']);
    expect(view(panel).querySelector('.chart-value')?.textContent?.trim()).toBe('2.0 KB');
    expect(view(panel).querySelector('.chart-svg')?.getAttribute('aria-label')).toBe(
      'Sessions. active: 3 sessions',
    );

    await panel.click('Move Size earlier', view(panel));
    expect(titles(panel)).toEqual(['Size', 'Sessions']);
    await panel.click('Move Size later', view(panel));
    await panel.click('Make Sessions wide', view(panel));
    expect(layout(panel).wide).toEqual(['sessions']);
    expect(view(panel).querySelector('.db-dash-wide h3')?.textContent).toContain('Sessions');

    const size = panel.control('Size', view(panel).querySelector('fieldset')!) as HTMLInputElement;
    size.click();
    await panel.settle();
    expect(titles(panel)).toEqual(['Sessions']);
    await panel.click('Hide Sessions', view(panel));
    expect(view(panel).textContent).toContain('No panel is shown');
    size.click();
    await panel.settle();
    expect(titles(panel)).toEqual(['Size']);

    const every = panel.control('Read every', view(panel)) as HTMLSelectElement;
    every.value = '2';
    every.dispatchEvent(new Event('change'));
    expect(layout(panel).interval).toBe(2);
    await panel.click('Pause', view(panel));
    const run = panel.section().dashboards.run(panel.section().tabs.active()!);
    expect(run.paused()).toBe(true);
    await panel.click('Resume', view(panel));
    expect(run.paused()).toBe(false);

    const tab = panel.section().tabs.active()!;
    panel.section().transactions.requestClose(tab.id);
    await panel.settle(10);
    expect(panel.calls('db.disconnect').some((call) => call['session'] === 'dashboard:c1')).toBe(
      true,
    );
  });

  it('names the driver’s panels in the language of the interface', async () => {
    const panel = await dashboardTab();
    TestBed.inject(TranslocoService).setActiveLang('es');
    await panel.settle(10);
    expect(titles(panel)).toEqual(['Sesiones', 'Tamaño']);
    const sessions = view(panel).querySelector('.db-dash-card')!;
    expect(sessions.getAttribute('aria-label')).toBe('Sesiones');
    expect(sessions.querySelector('svg, .chart-value')?.getAttribute('aria-label')).toContain(
      'activo: 3 sesiones',
    );
  });

  it('adds a panel of the person’s own only when its query reads', async () => {
    const panel = await dashboardTab();
    await panel.click('New panel', view(panel));
    const dialog = panel.dialog('New panel');
    await panel.fill('Title', 'Mine', dialog);
    await panel.fill('Query', 'DELETE FROM orders', dialog);
    await panel.fill('Chart', 'value', dialog);
    await panel.fill('Unit', 'rows', dialog);
    await panel.click('Save', dialog);
    expect(dialog.textContent).toContain('A panel only reads');
    expect(layout(panel).custom).toEqual([]);

    await panel.fill('Query', 'SELECT count(*) AS mine FROM orders', dialog);
    const counter = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    counter.click();
    counter.click();
    await panel.click('Save', dialog);
    await panel.settle(10);
    expect(layout(panel).custom[0]).toMatchObject({
      title: 'Mine',
      sql: 'SELECT count(*) AS mine FROM orders',
      chart: 'value',
      unit: 'rows',
      delta: false,
      custom: true,
    });
    expect(titles(panel)).toContain('Mine');

    await panel.click('Edit', view(panel));
    const editor = panel.dialog('Edit panel');
    await panel.settle();
    expect((panel.control('Title', editor) as HTMLInputElement).value).toBe('Mine');
    await panel.fill('Title', 'Ours', editor);
    await panel.click('Save', editor);
    await panel.settle(10);
    expect(titles(panel)).toContain('Ours');
    await panel.click('Delete', view(panel));
    expect(titles(panel)).not.toContain('Ours');
    await panel.click('New panel', view(panel));
    await panel.click('Cancel', panel.dialog('New panel'));
    expect(panel.root().querySelector('app-db-panel-editor')).toBeNull();
  });
});
