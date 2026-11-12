import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import { openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { vi } from 'vitest';
import { CodeEditor, languageSupport } from './code-editor';
import { CodeLanguage, CodeMark, bodyLanguage } from './code-language';

@Component({
  imports: [CodeEditor],
  template: `<app-code-editor
    [(value)]="text"
    [language]="language()"
    [marks]="marks()"
    [readonly]="locked()"
    [size]="size()"
    [words]="words()"
    label="Request body"
    placeholder="Write here"
  />`,
})
class Host {
  readonly text = signal('{"a": 1}');
  readonly language = signal<CodeLanguage>('json');
  readonly marks = signal<CodeMark[]>([]);
  readonly locked = signal(false);
  readonly size = signal<'small' | 'normal' | 'large'>('normal');
  readonly words = signal<string[]>([]);
}

describe('CodeEditor', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let editor: CodeEditor;
  const view = () => editor.editor()!;
  /** The name of the parser behind the text, once its language has loaded. */
  const parser = async (name: string) =>
    vi.waitFor(() => expect(syntaxTree(view().state).type.name).toBe(name));

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
    editor = fixture.debugElement.query(By.directive(CodeEditor)).componentInstance;
  });

  it('is named, and keeps its text in sync both ways', async () => {
    const content = (fixture.nativeElement as HTMLElement).querySelector('.cm-content')!;
    expect(content.getAttribute('aria-label')).toBe('Request body');
    expect(view().state.doc.toString()).toBe('{"a": 1}');
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: '[]' } });
    expect(host.text()).toBe('[]');
    host.text.set('{"b": 2}');
    await fixture.whenStable();
    expect(view().state.doc.toString()).toBe('{"b": 2}');
  });

  it('colours each language once it loads, and plain text without one', async () => {
    await parser('JsonText');
    for (const [language, name] of [
      ['javascript', 'Script'],
      ['yaml', 'Stream'],
      ['xml', 'Document'],
      ['html', 'Document'],
      ['graphql', 'Document'],
    ] as const) {
      host.language.set(language);
      await fixture.whenStable();
      await parser(name);
    }
    host.language.set('text');
    await fixture.whenStable();
    await parser('');
    // A slow language never replaces one chosen after it.
    host.language.set('yaml');
    host.language.set('json');
    await fixture.whenStable();
    await parser('JsonText');
    expect(await languageSupport('text')).toEqual([]);
  });

  it('marks problems on their lines and selects a line', async () => {
    host.text.set('openapi: 3.1.0\ninfo:\n  title: A\n');
    host.marks.set([
      { line: 2, severity: 'error', message: 'info.version is missing' },
      { line: 99, severity: 'warning', message: 'past the end' },
    ]);
    await fixture.whenStable();
    expect(diagnosticCount(view().state)).toBe(2);
    const found: string[] = [];
    forEachDiagnostic(view().state, (diagnostic, from) =>
      found.push(`${view().state.doc.lineAt(from).number} ${diagnostic.message}`),
    );
    expect(found).toEqual(['2 info.version is missing', '4 past the end']);
    host.marks.set([]);
    await fixture.whenStable();
    expect(diagnosticCount(view().state)).toBe(0);

    editor.selectLine(3);
    const selection = view().state.selection.main;
    expect(view().state.sliceDoc(selection.from, selection.to)).toBe('  title: A');
  });

  it('searches with its panel, can be read-only and has three sizes', async () => {
    openSearchPanel(view());
    expect(searchPanelOpen(view().state)).toBe(true);
    host.locked.set(true);
    await fixture.whenStable();
    expect(view().state.readOnly).toBe(true);
    host.locked.set(false);
    await fixture.whenStable();
    expect(view().state.readOnly).toBe(false);
    const element = fixture.debugElement.query(By.directive(CodeEditor))
      .nativeElement as HTMLElement;
    host.size.set('small');
    await fixture.whenStable();
    expect(element.classList.contains('small')).toBe(true);
    host.size.set('large');
    await fixture.whenStable();
    expect(element.classList.contains('large')).toBe(true);
  });

  it('suggests the words it is given, field paths with their dots', async () => {
    host.language.set('javascript');
    host.words.set(['customer.address.city', 'customer.name', 'status']);
    host.text.set('');
    await fixture.whenStable();
    await parser('Script');
    const suggest = async (text: string) => {
      view().dispatch({
        changes: { from: 0, to: view().state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      startCompletion(view());
      await vi.waitFor(() => expect(completionStatus(view().state)).not.toBe('pending'));
      return currentCompletions(view().state).map((option) => option.label);
    };
    expect(await suggest('{ customer.add')).toContain('customer.address.city');
    expect(await suggest('{ stat')).toContain('status');
    host.words.set([]);
    await fixture.whenStable();
    expect(await suggest('{ stat')).not.toContain('status');
  });

  it('suggests the pm and nx API in scripts, with how each member is used', async () => {
    host.language.set('script');
    host.text.set('');
    await fixture.whenStable();
    await parser('Script');
    const suggest = async (text: string) => {
      view().dispatch({
        changes: { from: 0, to: view().state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      startCompletion(view());
      await vi.waitFor(() => expect(completionStatus(view().state)).not.toBe('pending'));
      return currentCompletions(view().state);
    };
    const api = await suggest('pm.');
    expect(api.map((option) => option.label)).toContain('environment');
    const set = (await suggest('nx.environment.')).find((option) => option.label === 'set')!;
    expect(set.detail).toBe('(key, value)');
    expect(set.info).toBe('Sets a variable, saved when the request ends.');
    expect((await suggest('pm.response.to.')).map((option) => option.label)).toEqual(
      expect.arrayContaining(['have', 'be']),
    );
    expect((await suggest('pm.expect(json.items).to.')).map((option) => option.label)).toEqual(
      expect.arrayContaining(['equal', 'include', 'have']),
    );
    expect((await suggest('p')).map((option) => option.label)).toEqual(
      expect.arrayContaining(['pm']),
    );
    // Not inside strings or comments.
    expect((await suggest("const text = 'pm.")).map((option) => option.label)).not.toContain(
      'environment',
    );
    expect((await suggest('// pm.')).map((option) => option.label)).not.toContain('environment');
  });

  it('chooses the language of a raw body from its type', () => {
    expect(
      ['JSON', 'javascript', 'XML', 'HTML', 'GraphQL', 'Text', undefined].map(bodyLanguage),
    ).toEqual(['json', 'javascript', 'xml', 'html', 'graphql', 'text', 'text']);
  });

  it('does nothing before it exists', () => {
    const lone = TestBed.runInInjectionContext(() => new CodeEditor());
    lone.selectLine(1);
    expect(lone.editor()).toBeUndefined();
  });
});
