import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS } from '../../domain/db/grid/cells';
import { ResultColumn } from '../../domain/db/results';
import { buttons } from '../../testing/controls';
import { TEST_API, TestApi, testProviders } from '../../testing/providers';
import { ValueViewer } from './value-viewer';

@Component({
  imports: [ValueViewer],
  template: `<app-value-viewer [value]="value()" [column]="column()" [formats]="formats" />`,
})
class Host {
  readonly value = signal<unknown>(null);
  readonly column = signal<ResultColumn>({ name: '', typeName: 'text', kind: 'text' });
  readonly formats = DEFAULT_FORMATS;
}

describe('the value viewer of the grid', () => {
  let fixture: ComponentFixture<Host>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const show = async (value: unknown, name = '') => {
    fixture.componentInstance.value.set(value);
    fixture.componentInstance.column.set({ name, typeName: 'text', kind: 'text' });
    await settle();
  };
  const save = async () => {
    buttons(root(), 'Save to a file')[0].click();
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('saves each kind of value under its column name, or as value, with its extension', async () => {
    await show({ $t: 'json', v: '{"a":1}' });
    await save();
    await show({ $t: 'xml', v: '<a/>' }, 'doc');
    await save();
    await show('plain', 'note');
    await save();
    await show({ $t: 'binary' }, 'blob');
    await save();
    expect(api.downloads.map((download) => download.name)).toEqual([
      'value.json',
      'doc.xml',
      'note.txt',
      'blob.bin',
    ]);
  });

  it('says a value came cut even when its size is not known', async () => {
    await show({ $t: 'text', v: 'abc', truncated: true });
    expect(root().textContent).toContain('?');
  });
});
