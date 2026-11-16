import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DATABASES } from '../../composition/providers';
import { ResultColumn } from '../../domain/db/results';
import { testProviders } from '../../testing/providers';
import { GridFormatSettings } from '../grid-format-settings';
import { DataGrid } from './data-grid';

@Component({
  imports: [DataGrid, GridFormatSettings],
  template: `<div style="height: 200px; width: 600px; display: flex">
      <app-data-grid [columns]="columns" [rows]="rows" />
    </div>
    <app-grid-format-settings />`,
})
class Host {
  columns: ResultColumn[] = [
    { name: 'a', typeName: 'int4', kind: 'integer' },
    { name: 'b', typeName: 'numeric', kind: 'decimal' },
  ];
  rows = [[null, { $t: 'decimal', v: '1.5' }]];
}

describe('the formats of the data grids', () => {
  let fixture: ComponentFixture<Host>;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    }
  };
  const cells = () =>
    [...root().querySelectorAll('[role="gridcell"][data-column]')].map((cell) =>
      cell.textContent?.trim(),
    );

  it('writes values as Settings say, for every grid, and remembers it', async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
    expect(cells()).toEqual(['NULL', '1.5']);
    const text = root().querySelector<HTMLInputElement>('app-grid-format-settings input')!;
    text.value = '∅';
    text.dispatchEvent(new Event('input'));
    const decimal = root().querySelector<HTMLSelectElement>('app-grid-format-settings select')!;
    decimal.value = ',';
    decimal.dispatchEvent(new Event('input'));
    decimal.dispatchEvent(new Event('change'));
    await settle();
    expect(cells()).toEqual(['∅', '1,5']);
    const cases = await TestBed.inject(DATABASES)();
    expect(cases.statements.gridFormats()).toEqual({ nullText: '∅', decimal: ',', dates: 'iso' });
  });
});
