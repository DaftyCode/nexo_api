import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { ResultChartConfig } from '../../domain/db/result-chart';
import { buttons, control } from '../../testing/controls';
import { TEST_API, TestApi, testProviders } from '../../testing/providers';
import { WorkspaceState } from '../workspace-state';
import { ResultChart } from './result-chart';

const columns = [
  { name: 'day', kind: 'date', typeName: 'date' },
  { name: 'city', kind: 'text', typeName: 'text' },
  { name: 'orders', kind: 'integer', typeName: 'int4' },
];
const rows = [
  ['2024-01-02', 'Lima', 3],
  ['2024-01-01', 'Quito', 2],
  ['2024-01-01', 'Lima', 4],
];

async function start(saved?: ResultChartConfig) {
  await TestBed.configureTestingModule({
    providers: testProviders(),
    imports: [ResultChart],
  }).compileComponents();
  const fixture: ComponentFixture<ResultChart> = TestBed.createComponent(ResultChart);
  fixture.componentRef.setInput('columns', columns);
  fixture.componentRef.setInput('rows', rows);
  if (saved) fixture.componentRef.setInput('saved', saved);
  const changes: ResultChartConfig[] = [];
  fixture.componentInstance.changed.subscribe((config) => {
    changes.push(config);
    fixture.componentRef.setInput('saved', config);
  });
  let readAll = 0;
  fixture.componentInstance.readAll.subscribe(() => readAll++);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const choose = async (label: string, value: string) => {
    const select = control(root, label) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  const click = async (text: string | RegExp) => {
    buttons(root, text)[0].click();
    await fixture.whenStable();
  };
  return { fixture, root, changes, choose, click, readAll: () => readAll };
}

describe('the chart of a result', () => {
  it('draws a time line of a date without being told, and its numbers as a table', async () => {
    const chart = await start();
    expect(chart.root.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Chart of day: 2 categories, 1 series',
    );
    expect(chart.root.querySelectorAll('path.rc-line')).toHaveLength(1);
    expect(chart.root.textContent).toContain('3 rows');
    await chart.click('Show as a table');
    const cells = [...chart.root.querySelectorAll('tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent?.trim()),
    );
    expect(cells).toEqual([
      ['2024-01-01', '6'],
      ['2024-01-02', '3'],
    ]);
  });

  it('becomes stacked bars by city with a series per day, and hides a series from the legend', async () => {
    const chart = await start();
    await chart.choose('Chart', 'stacked');
    await chart.choose('X axis', 'city');
    await chart.choose('One series per value of', 'day');
    expect(chart.changes.at(-1)).toMatchObject({ type: 'stacked', x: 'city', group: 'day' });
    expect(chart.root.querySelectorAll('rect.rc-shape')).toHaveLength(3);
    const legend = chart.root.querySelector('[aria-label="Legend"]')!;
    expect(legend.textContent).toContain('2024-01-02');
    (buttons(legend as HTMLElement, '2024-01-02')[0] as HTMLButtonElement).click();
    await chart.fixture.whenStable();
    expect(chart.root.querySelectorAll('rect.rc-shape')).toHaveLength(2);
    // The value under the keyboard.
    const bar = chart.root.querySelector<SVGRectElement>('rect.rc-shape')!;
    bar.dispatchEvent(new Event('focus'));
    await chart.fixture.whenStable();
    expect(chart.root.querySelector('.rc-tip')?.textContent).toContain('2024-01-01 · Lima: 4');
    bar.dispatchEvent(new Event('blur'));
    await chart.fixture.whenStable();
    expect(chart.root.querySelector('.rc-tip')).toBeNull();
  });

  it('changes its aggregate, order, scale, names and series, and draws pies and dots', async () => {
    const chart = await start();
    await chart.choose('Repeated values', 'count');
    await chart.choose('Order', 'desc');
    const limit = control(chart.root, 'Categories at most') as HTMLInputElement;
    limit.value = '1';
    limit.dispatchEvent(new Event('change'));
    (control(chart.root, 'Logarithmic scale') as HTMLInputElement).click();
    for (const [label, value] of [
      ['Title', 'Orders'],
      ['Name of the X axis', 'Day'],
      ['Name of the value axis', 'Count'],
    ]) {
      const input = control(chart.root, label) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('change'));
    }
    await chart.fixture.whenStable();
    expect(chart.changes.at(-1)).toMatchObject({
      aggregate: 'count',
      order: 'desc',
      limit: 1,
      log: true,
      title: 'Orders',
      xLabel: 'Day',
      yLabel: 'Count',
    });
    expect(chart.root.querySelector('figcaption')?.textContent).toContain('Orders');
    const series = [...chart.root.querySelectorAll<HTMLInputElement>('fieldset input')];
    series[0].click();
    await chart.fixture.whenStable();
    expect(chart.changes.at(-1)?.y).toEqual(['orders', 'city']);
    await chart.choose('Chart', 'pie');
    expect(chart.root.querySelectorAll('path.rc-shape').length).toBeGreaterThan(0);
    expect(chart.root.textContent).toContain('The rest');
    await chart.choose('Chart', 'scatter');
    expect(chart.root.querySelectorAll('circle.rc-dot').length).toBeGreaterThan(0);
    await chart.choose('Chart', 'hbar');
    expect(chart.root.querySelectorAll('rect.rc-shape').length).toBeGreaterThan(0);
  });

  it('says when more rows can be read, and exports and prints itself', async () => {
    const chart = await start();
    chart.fixture.componentRef.setInput('more', true);
    await chart.fixture.whenStable();
    expect(chart.root.textContent).toContain('3 rows of more than 3');
    await chart.click('Read every row');
    expect(chart.readAll()).toBe(1);
    const api = TestBed.inject(TEST_API) as TestApi;
    await chart.click(/^SVG$/);
    expect(api.downloads[0].name).toBe('chart.svg');
    expect(api.downloads[0].content).toContain('<svg');
    const state = TestBed.inject(WorkspaceState);
    await chart.click(/^Print$/);
    expect(state.report()).toMatchObject({
      kind: 'diagram',
      diagram: { caption: { key: 'db.chart.printed' } },
    });
    // A PNG needs a canvas, which this browser has not: it is said.
    await chart.click(/^PNG$/);
    await chart.fixture.whenStable();
  });
});
