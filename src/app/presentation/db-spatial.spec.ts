import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { buttons, control } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { startDbPanel } from '../testing/db-panel';
import { DbSpatial } from './db-spatial';

const point = (x: number, y: number) => `SRID=4326;POINT(${x} ${y})`;
const columns = [
  { name: 'name', kind: 'text', typeName: 'text' },
  { name: 'kind', kind: 'text', typeName: 'text' },
  { name: 'shape', kind: 'spatial', typeName: 'geometry' },
  { name: 'other', kind: 'spatial', typeName: 'geometry' },
];
const rows = [
  ['Lima', 'city', { $t: 'spatial', v: point(-77, -12) }, null],
  ['Park', 'area', 'POLYGON ((0 0, 1 0, 1 1, 0 0))', 'POINT (9 9)'],
  ['Road', 'line', 'LINESTRING (0 0, 2 2)', null],
  ['Nothing', 'none', null, null],
];

async function start(compact = false) {
  await TestBed.configureTestingModule({
    providers: testProviders(),
    imports: [DbSpatial],
  }).compileComponents();
  const fixture: ComponentFixture<DbSpatial> = TestBed.createComponent(DbSpatial);
  fixture.componentRef.setInput('columns', columns);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('compact', compact);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const click = async (text: string | RegExp) => {
    buttons(root, text)[0].click();
    await fixture.whenStable();
  };
  return { fixture, root, click };
}

describe('the spatial view', () => {
  it('draws every geometry, chooses a row from its figure and colors by a column', async () => {
    const view = await start();
    const svg = view.root.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('3 geometries');
    expect(view.root.querySelectorAll('circle')).toHaveLength(1);
    expect(view.root.querySelectorAll('path')).toHaveLength(2);
    expect(view.root.textContent).toContain('drawn in Web Mercator');
    view.root.querySelector('circle')!.dispatchEvent(new Event('click'));
    await view.fixture.whenStable();
    expect(view.root.querySelector('.sp-row')?.textContent).toContain('Row 1');
    expect(view.root.querySelector('.sp-row')?.textContent).toContain('name: Lima · kind: city');
    const color = control(view.root, 'Color by') as HTMLSelectElement;
    color.value = '1';
    color.dispatchEvent(new Event('change'));
    await view.fixture.whenStable();
    expect(view.root.querySelector('path')?.getAttribute('class')).toContain('sp-color-1');
    // Another column of geometries.
    const column = control(view.root, 'Geometry column') as HTMLSelectElement;
    column.value = '3';
    column.dispatchEvent(new Event('change'));
    await view.fixture.whenStable();
    expect(svg.getAttribute('aria-label')).toBe('1 geometries');
    expect(view.root.textContent).toContain('Drawn in the units of its own system');
  });

  it('zooms, moves and fits, and lists the geometries with their boxes', async () => {
    const view = await start();
    const svg = view.root.querySelector('svg')!;
    const fitted = svg.getAttribute('viewBox');
    await view.click('Zoom in');
    expect(svg.getAttribute('viewBox')).not.toBe(fitted);
    await view.click('Fit to the data');
    expect(svg.getAttribute('viewBox')).toBe(fitted);
    svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    await view.fixture.whenStable();
    await view.click('Zoom out');
    svg.getBoundingClientRect = () => ({ width: 100, height: 50 }) as DOMRect;
    svg.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    svg.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 10 }));
    svg.dispatchEvent(new MouseEvent('pointerup'));
    svg.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 10 }));
    await view.fixture.whenStable();
    expect(svg.getAttribute('viewBox')).not.toBe(fitted);
    await view.click('Show as a list');
    const listed = [...view.root.querySelectorAll('tbody tr')].map((row) =>
      row.children[1].textContent?.trim(),
    );
    expect(listed).toEqual(['Point', 'Polygon', 'LineString']);
    await view.click(/^2$/);
    expect(view.root.querySelector('tr.sp-chosen')?.textContent).toContain('Polygon');
    expect(view.root.querySelector('tbody tr')?.textContent).toContain('-77, -12 → -77, -12');
  });

  it('copies the geometry chosen and exports the rows as GeoJSON', async () => {
    const view = await start();
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
    view.root.querySelector('path')!.dispatchEvent(new Event('click'));
    await view.fixture.whenStable();
    await view.click('Copy as WKT');
    await view.click('Copy as GeoJSON');
    expect(copied).toEqual([
      'POLYGON ((0 0, 1 0, 1 1, 0 0))',
      '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
    ]);
    await view.click(/^GeoJSON$/);
    const api = TestBed.inject(TEST_API) as TestApi;
    const file = JSON.parse(api.downloads[0].content);
    expect(file.features).toHaveLength(4);
    expect(file.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-77, -12] },
      properties: { name: 'Lima', kind: 'city', other: null },
    });
    expect(file.features[3].geometry).toBeNull();
  });

  it('shows one geometry without its tools in the Value panel', async () => {
    const view = await start(true);
    expect(view.root.querySelector('.sp-tools')).toBeNull();
    expect(view.root.querySelector('svg')).not.toBeNull();
  });
});

describe('a result with geometries', () => {
  it('has a Spatial view, and its cells show their WKT', async () => {
    const panel = await startDbPanel({
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': (payload: Record<string, unknown>) => {
          const text = String(payload['script']).trim();
          const classification = {
            kind: 'read',
            missingWhere: false,
            truncate: false,
            drop: [],
            drops: false,
          };
          return {
            statements: [{ text, start: 0, end: text.length, line: 1, classification }],
            current: 0,
          };
        },
        'db.execute': () => ({
          columns: [{ name: 'geom', kind: 'spatial', typeName: 'geometry' }],
          rows: [[{ $t: 'spatial', v: '0101000020E6100000000000000000F03F0000000000000040' }]],
          elapsedMs: 1,
        }),
      },
    });
    const editor = panel.root().querySelector('.cm-content[aria-label="SQL script"]')!;
    const { typeCode } = await import('../testing/controls');
    typeCode(editor, 'select geom from places');
    await panel.settle();
    await panel.click(/^▶ Run$/);
    expect(panel.root().querySelector('[role="grid"]')?.textContent).toContain(
      'SRID=4326;POINT (1 2)',
    );
    const views = panel.root().querySelector<HTMLElement>('[aria-label="Result views"]')!;
    await panel.click('Spatial', views);
    expect(panel.root().querySelector('app-db-spatial circle')).not.toBeNull();
  });
});
