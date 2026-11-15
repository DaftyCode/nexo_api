import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../../testing/providers';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { ResultColumn } from '../../domain/db/results';
import { DataGrid } from './data-grid';

const COLUMNS = 200;
const ROWS = 100_000;

@Component({
  imports: [DataGrid],
  template: `<div style="height: 400px; width: 900px; display: flex">
    <app-data-grid
      [columns]="columns"
      [rows]="rows"
      [more]="more()"
      [(view)]="view"
      (needMore)="asked = asked + 1"
    />
  </div>`,
})
class Host {
  columns: ResultColumn[] = Array.from({ length: COLUMNS }, (_, index) => ({
    name: `c${index}`,
    typeName: 'int4',
    kind: 'integer',
  }));
  rows = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLUMNS }, (_, column) => (column === 1 ? `text ${row}` : row * column)),
  );
  more = signal(true);
  view = signal<GridView>(emptyView());
  asked = 0;
}

describe('DataGrid', () => {
  let fixture: ComponentFixture<Host>;
  const root = () => fixture.nativeElement as HTMLElement;
  const grid = () => root().querySelector<HTMLElement>('[role="grid"]')!;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    }
  };
  const press = async (key: string, extra: KeyboardEventInit = {}) => {
    grid().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('draws only the cells in sight of 100 000 rows and 200 columns', async () => {
    const cells = root().querySelectorAll('[role="gridcell"]').length;
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThan(1000);
    expect(grid().getAttribute('aria-rowcount')).toBe(String(ROWS + 1));
    expect(grid().getAttribute('aria-colcount')).toBe(String(COLUMNS + 1));
    grid().scrollTop = 1_000_000;
    grid().dispatchEvent(new Event('scroll'));
    await settle();
    expect(root().querySelectorAll('[role="gridcell"]').length).toBeLessThan(1000);
  });

  it('moves the active cell with the keyboard and asks for more rows near the end', async () => {
    await press('ArrowDown');
    await press('ArrowRight');
    const active = grid().getAttribute('aria-activedescendant')!;
    expect(root().querySelector(`#${active}`)?.textContent?.trim()).toBe('text 1');
    await press('ArrowDown', { ctrlKey: true });
    expect(grid().getAttribute('aria-activedescendant')).toContain(`${ROWS - 1}-1`);
    expect(fixture.componentInstance.asked).toBe(1);
  });

  it('sorts by a header and keeps the order in its view', async () => {
    const header = () => root().querySelectorAll<HTMLButtonElement>('.grid-sort')[1];
    header().click();
    await settle();
    header().click();
    await settle();
    expect(fixture.componentInstance.view().sort).toEqual({ column: 1, descending: true });
    expect(root().querySelector('[role="columnheader"][aria-sort="descending"]')).not.toBeNull();
    const first = root().querySelector('[aria-rowindex="2"] [role="gridcell"][aria-colindex="3"]');
    expect(first?.textContent?.trim()).toBe(`text ${ROWS - 1}`);
  });
});
