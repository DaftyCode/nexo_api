import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ResultColumn } from '../../domain/db/results';
import { testProviders } from '../../testing/providers';
import { DataGrid } from './data-grid';

/** A screen that opens the cells of its second column itself (as MongoDB's documents). */
@Component({
  imports: [DataGrid],
  template: `<div style="height: 300px; width: 900px; display: flex">
    <app-data-grid
      [columns]="columns"
      [rows]="rows"
      [opens]="opens"
      (opened)="opened.push($event)"
      (activeCell)="active.push($event)"
    />
  </div>`,
})
class Host {
  columns: ResultColumn[] = [
    { name: 'name', typeName: 'String', kind: 'text' },
    { name: 'address', typeName: 'Document', kind: 'json' },
  ];
  rows = [
    ['Ana', '{ 2 fields }'],
    ['Luis', '{ 2 fields }'],
  ];
  opens = (_row: number, column: number) => column === 1;
  opened: { row: number; column: number }[] = [];
  active: { row: number; column: number; whole: boolean }[] = [];
}

describe('cells a screen opens itself, and the cell the person is on', () => {
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
  const cell = (row: number, column: number) =>
    root().querySelector<HTMLElement>(
      `[role="gridcell"][data-row="${row}"][data-column="${column}"]`,
    )!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('opens with a double click or Enter what the screen opens, and shows the value otherwise', async () => {
    const host = fixture.componentInstance;
    cell(1, 1).click();
    cell(1, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(host.opened).toEqual([{ row: 1, column: 1 }]);
    expect(root().querySelector('.grid-panel')).toBeNull();
    grid().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(host.opened).toHaveLength(2);
    // A cell the screen does not open shows its value, as in every grid.
    cell(0, 0).click();
    cell(0, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(host.opened).toHaveLength(2);
    expect(root().querySelector('.grid-panel')).not.toBeNull();
  });

  it('says which cell the person is on, and when the whole row was chosen', async () => {
    const host = fixture.componentInstance;
    cell(1, 1).click();
    await settle();
    expect(host.active.at(-1)).toEqual({ row: 1, column: 1, whole: false });
    root().querySelector<HTMLElement>('[role="rowheader"][data-row="0"]')!.click();
    await settle();
    expect(host.active.at(-1)).toEqual({ row: 0, column: 0, whole: true });
  });
});
