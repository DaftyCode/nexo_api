import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResultColumn } from '../../domain/db/results';
import { buttons, clickButton } from '../../testing/controls';
import { testProviders } from '../../testing/providers';
import { DataGrid } from './data-grid';

/** A PNG header, as a binary column holds it. */
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

@Component({
  imports: [DataGrid],
  template: `<div style="height: 300px; width: 900px; display: flex">
    <app-data-grid [columns]="columns" [rows]="rows" [more]="true" (readAll)="all = all + 1" />
  </div>`,
})
class Host {
  columns: ResultColumn[] = [
    { name: 'doc', typeName: 'jsonb', kind: 'json', nullable: true },
    { name: 'markup', typeName: 'xml', kind: 'xml', nullable: false, key: true },
    {
      name: 'picture',
      typeName: 'bytea',
      kind: 'binary',
      origin: { schema: 'shop', table: 'items', column: 'picture' },
    },
    { name: 'day', typeName: 'timestamp', kind: 'timestamp' },
    { name: 'total', typeName: 'numeric', kind: 'decimal' },
  ];
  rows = [
    [
      { $t: 'json', v: '{"a":[1,2]}' },
      { $t: 'xml', v: '<a><b>x</b></a>' },
      { $t: 'binary', v: PNG },
      { $t: 'timestamp', v: '2026-11-13T10:20:30' },
      { $t: 'decimal', v: '2.5' },
    ],
    [
      null,
      { $t: 'xml', v: '<c/>' },
      { $t: 'binary', v: 'AAEC', truncated: true, size: 4096 },
      null,
      { $t: 'decimal', v: '1.5' },
    ],
  ];
  all = 0;
}

describe('the panels and tools of the data grid', () => {
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
  const panel = () => root().querySelector<HTMLElement>('.grid-panel')!;
  /** Chooses an entry of a menu of the grid, opened by the button named `opener`. */
  const choose = async (opener: string, entry: string | RegExp) => {
    await clickButton(fixture, opener);
    await settle();
    buttons(root().querySelector('[role="menu"]')!, entry)[0].click();
    await settle();
  };
  /** An entry of the grid's tools: the `⋯` at the end of its header. */
  const tool = (entry: string) => choose('Grid tools', entry);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('shows the active value by its class, and the metadata and figures', async () => {
    await tool('Value');
    expect(panel().querySelector('.cm-content')?.textContent).toContain('"a": [');
    await press('ArrowRight');
    expect(panel().querySelector('.cm-content')?.textContent).toContain('<b>x</b>');
    await press('ArrowRight');
    expect(panel().querySelector('img')?.getAttribute('src')).toContain('data:image/png;base64,');
    await clickButton(fixture, 'Save to a file', panel());
    await press('ArrowRight');
    expect(panel().textContent).toContain('2026-11-13T10:20:30');
    await press('ArrowRight');
    expect(panel().textContent).toContain('2.5');
    await press('ArrowDown');
    await press('ArrowLeft');
    expect(panel().textContent).toContain('NULL');
    await press('ArrowLeft');
    expect(panel().textContent).toContain('4096');
    await clickButton(fixture, 'Save to a file', panel());

    await tool('Metadata');
    const meta = panel().textContent!;
    expect(meta).toContain('jsonb');
    expect(meta).toContain('shop.items.picture');
    // The figures of the selected cells: a column, from its header.
    await tool('Calc');
    expect(panel().textContent).toContain('Count');
    await tool('Grouping');
    expect(panel()).toBeTruthy();
    await clickButton(fixture, 'Close the panel', panel());
    await settle();
    expect(root().querySelector('.grid-panel')).toBeNull();
  });

  it('finds, shows a record and the text view, copies and reads everything', async () => {
    let copied = '';
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    await tool('Find');
    const find = root().querySelector<HTMLInputElement>('.grid-find input')!;
    find.value = 'x';
    find.dispatchEvent(new Event('input'));
    await settle();
    expect(root().querySelector('.grid-find')?.textContent).toContain('found');
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await clickButton(fixture, 'Next');
    await clickButton(fixture, 'Previous');
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    await tool('Record');
    expect(root().querySelector('.grid-record')?.textContent).toContain('markup');
    await clickButton(fixture, 'Next', root().querySelector('.grid-record')!);
    await clickButton(fixture, 'Previous', root().querySelector('.grid-record')!);
    // The record and text views leave the grid, and its bar leads back to it.
    await clickButton(fixture, 'Back to the grid');
    await settle();
    await tool('Text view');
    expect(root().querySelector('.grid-plain')?.textContent).toContain('total');
    await clickButton(fixture, 'Back to the grid');
    await settle();

    await choose('Export', /^JSON$/);
    // The selection as JSON: the cell «Find» left active, on its match.
    expect(JSON.parse(copied)).toEqual([{ markup: '<a><b>x</b></a>' }]);
    await clickButton(fixture, 'Read all');
    expect(fixture.componentInstance.all).toBe(1);
  });
});
