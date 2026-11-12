import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  model,
  untracked,
  viewChild,
} from '@angular/core';
import { FormValueControl } from '@angular/forms/signals';
import { Diagnostic, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { baseExtensions, lineSpan, readOnly, wordCompletions } from './code-editor-setup';
import { CodeLanguage, CodeMark } from './code-language';

export type { CodeLanguage, CodeMark } from './code-language';

/** Each language loads apart, the first time an editor uses it. */
export async function languageSupport(language: CodeLanguage): Promise<Extension> {
  switch (language) {
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'script': {
      const [{ javascript, javascriptLanguage }, { scriptCompletions }] = await Promise.all([
        import('@codemirror/lang-javascript'),
        import('./script-completion'),
      ]);
      return [javascript(), javascriptLanguage.data.of({ autocomplete: scriptCompletions })];
    }
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'xml':
    case 'html':
      return (await import('@codemirror/lang-xml')).xml();
    case 'graphql':
      return (await import('cm6-graphql')).graphqlLanguageSupport();
    default:
      return [];
  }
}

/**
 * A code editor (CodeMirror 6) for bodies, scripts, definitions and messages: colours for its
 * language, undo, search with Ctrl+F, and problems marked on their lines. It works with
 * Signal Forms (`[formField]`) or with `[(value)]`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-code-editor',
  template: '<div #host class="code-host"></div>',
  styles: `
    :host {
      display: block;
      height: 175px;
      resize: vertical;
      overflow: hidden;
    }
    :host(.small) {
      height: 100px;
    }
    :host(.large) {
      height: 320px;
    }
    .code-host {
      height: 100%;
    }
  `,
  host: { '[class.small]': "size() === 'small'", '[class.large]': "size() === 'large'" },
})
export class CodeEditor implements FormValueControl<string> {
  readonly value = model('');
  readonly language = input<CodeLanguage>('text');
  /** The accessible name of the editing area. */
  readonly label = input('');
  readonly placeholder = input('');
  readonly size = input<'small' | 'normal' | 'large'>('normal');
  readonly readonly = input(false);
  /** Problems to mark, by line. */
  readonly marks = input<readonly CodeMark[]>([]);
  /** Words suggested while typing, such as the field names of a collection. */
  readonly words = input<readonly string[]>([]);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: EditorView | undefined;
  private readonly languages = new Compartment();
  private readonly editable = new Compartment();
  private readonly completions = new Compartment();
  /** The language last asked for, so a slow load never replaces a newer one. */
  private wanted: CodeLanguage = 'text';

  constructor() {
    afterNextRender(() => this.create());
    effect(() => {
      const value = this.value();
      untracked(() => {
        const view = this.view;
        if (view && value !== view.state.doc.toString())
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      });
    });
    effect(() => {
      const language = this.language();
      untracked(() => void this.useLanguage(language));
    });
    effect(() => {
      const value = this.readonly();
      untracked(() => this.view?.dispatch({ effects: this.editable.reconfigure(readOnly(value)) }));
    });
    effect(() => {
      const words = this.words();
      untracked(() =>
        this.view?.dispatch({ effects: this.completions.reconfigure(wordCompletions(words)) }),
      );
    });
    effect(() => {
      const marks = this.marks();
      untracked(() => this.mark(marks));
    });
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  private create() {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          ...baseExtensions({
            label: this.label(),
            placeholder: this.placeholder(),
            changed: (text) => this.value.set(text),
          }),
          this.languages.of([]),
          this.editable.of(readOnly(this.readonly())),
          this.completions.of(wordCompletions(this.words())),
        ],
      }),
    });
    void this.useLanguage(this.language());
    this.mark(this.marks());
  }
  private async useLanguage(language: CodeLanguage) {
    this.wanted = language;
    const support = await languageSupport(language);
    if (this.view && this.wanted === language)
      this.view.dispatch({ effects: this.languages.reconfigure(support) });
  }
  private mark(marks: readonly CodeMark[]) {
    const view = this.view;
    if (!view) return;
    const diagnostics: Diagnostic[] = marks.map((mark) => ({
      ...lineSpan(view, mark.line),
      severity: mark.severity,
      message: mark.message,
    }));
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }

  /** Selects a line, scrolls to it and takes the focus. */
  selectLine(line: number) {
    const view = this.view;
    if (!view) return;
    const { from, to } = lineSpan(view, line);
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  }
  /** The CodeMirror view, once created; for tests and callers that move the cursor. */
  editor() {
    return this.view;
  }
}
