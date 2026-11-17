import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Group } from '../../domain/db/grid/calc';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { ResultColumn } from '../../domain/db/results';
import { buttons, clickButton } from '../../testing/controls';
import { testProviders } from '../../testing/providers';
import type { GridEditing } from './cell-editor';
import { DataGrid } from './data-grid';

@Component({
  imports: [DataGrid],
  template: `<div style="height: 300px; width: 900px; display: flex">
    <app-data-grid
      [columns]="columns"
      [rows]="rows"
      [grouping]="grouping"
      [editing]="editing()"
      [cellActions]="actions"
      [view]="view()"
      (viewChange)="view.set($event)"
      (cellAction)="chosen.push($event.action)"
    />
  </div>`,
})
class Host {
  columns: ResultColumn[] = [
    {
      name: 'id',
      typeName: 'int4',
      kind: 'integer',
      key: true,
      origin: { table: 't', column: 'id' },
    },
    { name: 'city', typeName: 'text', kind: 'text', origin: { table: 't', column: 'city' } },
  ];
  rows = [
    [1, 'Madrid'],
    [2, 'Lima'],
    [3, 'Madrid'],
  ];
  view = signal<GridView>(emptyView());
  editing = signal<GridEditing | undefined>(undefined);
  actions = [{ id: 'filter.eq', label: 'Equal to this value' }];
  chosen: string[] = [];
  groups: Group[] | Error = [{ values: ['Madrid'], count: 9 }];
  grouping = async () => {
    if (this.groups instanceof Error) throw this.groups;
    return this.groups;
  };
}

describe('the menus and panels of the data grid', () => {
  let fixture: ComponentFixture<Host>;
  let copied: string[];
  const root = () => fixture.nativeElement as HTMLElement;
  const grid = () => root().querySelector<HTMLElement>('[role="grid"]')!;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    }
  };
  const menu = () => root().querySelector<HTMLElement>('[role="menu"]')!;
  const pick = async (entry: string | RegExp) => {
    buttons(menu(), entry)[0].click();
    await settle();
  };
  const columnMenu = async (at: number) => {
    root().querySelectorAll<HTMLElement>('.grid-head-menu')[at].click();
    await settle();
  };
  const press = async (key: string, extra: KeyboardEventInit = {}) => {
    grid().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
    );
    await settle();
  };

  beforeEach(async () => {
    copied = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => void copied.push(text),
        readText: async () => '9\tLeón',
      },
    });
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });
  afterEach(() => Reflect.deleteProperty(globalThis.navigator, 'clipboard'));

  it('sorts, sizes, moves, pins and hides a column from its menu', async () => {
    const host = fixture.componentInstance;
    await columnMenu(1);
    await pick('Sort descending');
    expect(host.view().sort).toEqual({ column: 1, descending: true });
    await columnMenu(1);
    await pick('Remove the order');
    expect(host.view().sort).toBeUndefined();
    await columnMenu(1);
    await pick('Wider');
    expect(Object.keys(host.view().widths)).toEqual(['1']);
    await columnMenu(1);
    await pick('Move left');
    expect(host.view().order).toEqual([1, 0]);
    await columnMenu(0);
    await pick('Pin the column');
    expect(host.view().pinned.length).toBe(1);
    await columnMenu(1);
    await pick('Hide the column');
    expect(host.view().hidden.length).toBe(1);
    await clickButton(fixture, 'Grid tools');
    await settle();
    await pick('Find');
    expect(root().querySelector('input[type="search"], [aria-label*="Find"]')).not.toBeNull();
  });

  it('copies a row in every format from its menu, and runs a cell action', async () => {
    const host = fixture.componentInstance;
    root().querySelectorAll<HTMLElement>('[aria-label="Actions of row 1"]')[0]?.click();
    await settle();
    await pick('Copy as JSON');
    expect(copied.at(-1)).toContain('"city": "Madrid"');
    root().querySelectorAll<HTMLElement>('[aria-label="Actions of row 2"]')[0]?.click();
    await settle();
    await pick('Copy as UPDATE');
    expect(copied.at(-1)).toBe("UPDATE t SET city = 'Lima' WHERE id = 2;");
    root().querySelectorAll<HTMLElement>('[aria-label="Actions of row 1"]')[0]?.click();
    await settle();
    await pick('Equal to this value');
    expect(host.chosen).toEqual(['filter.eq']);
    root().querySelectorAll<HTMLElement>('[aria-label="Actions of row 1"]')[0]?.click();
    await settle();
    await pick('Show the record');
    expect(root().textContent).toContain('city');
  });

  it('groups by the columns chosen or dropped, and on the server', async () => {
    const host = fixture.componentInstance;
    await clickButton(fixture, 'Grid tools');
    await settle();
    await pick('Grouping');
    const panel = () => root().querySelector<HTMLElement>('.grid-panel')!;
    await clickButton(fixture, 'city', panel());
    await settle();
    expect(panel().textContent).toContain('Madrid');
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'id' } });
    panel().querySelector('[aria-label="Group by"]')!.dispatchEvent(drop);
    await settle();
    await clickButton(fixture, 'Group the whole table on the server', panel());
    await settle();
    expect(panel().textContent).toContain('9');
    host.groups = new Error('no server');
    await clickButton(fixture, 'Group the whole table on the server', panel());
    await settle();
    expect(panel().textContent).toContain('no server');
    await clickButton(fixture, 'city', panel());
    await clickButton(fixture, 'id', panel());
    await settle();
  });

  it('opens the value with a double click, and the cell menu with a right click', async () => {
    const cell = root().querySelector<HTMLElement>('[data-column="1"]')!;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(root().querySelector('.grid-panel')).not.toBeNull();
    cell.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await settle();
    expect(menu()).not.toBeNull();
    grid().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    await press('ContextMenu');
    await press('F10', { shiftKey: true });
  });

  it('pastes a block and edits a cell in place when the rows can be edited', async () => {
    const edits: string[] = [];
    const pasted: string[][][] = [];
    fixture.componentInstance.editing.set({
      reason: () => '',
      mark: () => undefined,
      edit: (_row, _column, text) => {
        edits.push(text);
        return '';
      },
      paste: (_row, _column, block) => {
        pasted.push(block);
        return '';
      },
    });
    await settle();
    root()
      .querySelector<HTMLElement>('[data-column="0"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await press('v', { ctrlKey: true });
    await new Promise((done) => setTimeout(done));
    expect(pasted).toEqual([[['9', 'León']]]);
    await press('F2');
    await new Promise((done) => setTimeout(done));
    await settle();
    const input = root().querySelector<HTMLInputElement>('input.grid-editor')!;
    expect(input.getAttribute('aria-label')).toBe('Edit id');
    input.value = '42';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(edits).toEqual(['42']);
    await press('Escape');
    const cell = root().querySelector<HTMLElement>('[data-column="0"]')!;
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
  });
});
