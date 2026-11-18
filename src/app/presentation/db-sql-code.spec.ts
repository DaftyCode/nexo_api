import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { CodeScheme } from './code-scheme';
import { DbSqlCode } from './db-sql-code';

@Component({ imports: [DbSqlCode], template: '<app-db-sql-code text="select 1" />' })
class Host {}

describe('DbSqlCode', () => {
  it('starts light on a template with light code and turns dark with the template', async () => {
    const dark = signal(false);
    TestBed.inject(CodeScheme).follow(dark);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.cm-editor');
    const view = EditorView.findFromDOM(element!)!;
    expect(view.state.doc.toString()).toBe('select 1');
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    dark.set(true);
    await fixture.whenStable();
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  });
});
