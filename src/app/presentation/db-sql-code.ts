import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import {
  Compartment,
  EditorState,
  Extension,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { baseExtensions, wordCompletions } from './code-editor-setup';

/** What the keys of the SQL editor ask for, with DBeaver's shortcuts. */
export type SqlCommand = 'run' | 'run-new' | 'script' | 'save' | 'cancel' | 'previous' | 'next';

/** The SQL dialect of CodeMirror for a driver, loaded with the editor. */
async function sqlSupport(driver: string): Promise<Extension> {
  const sql = await import('@codemirror/lang-sql');
  const dialects: Record<string, typeof sql.StandardSQL> = {
    postgres: sql.PostgreSQL,
    mssql: sql.MSSQL,
    mysql: sql.MySQL,
    mariadb: sql.MariaSQL,
    sqlite: sql.SQLite,
    oracle: sql.PLSQL,
    cassandra: sql.Cassandra,
  };
  return sql.sql({ dialect: dialects[driver] ?? sql.StandardSQL, upperCaseKeywords: true });
}

/** Marks the text that last ran. */
const setRan = StateEffect.define<{ from: number; to: number } | undefined>();
const ranMark = Decoration.mark({ class: 'cm-sql-ran' });
const ranField = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setRan))
        marks =
          effect.value && effect.value.to > effect.value.from
            ? Decoration.set([ranMark.range(effect.value.from, effect.value.to)])
            : Decoration.none;
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const ranTheme = EditorView.theme({
  '.cm-sql-ran': { backgroundColor: 'var(--nexo-color-accent-soft)' },
});

/**
 * The text of a SQL tab: CodeMirror with the dialect of the connection, folding, comments
 * (Ctrl+/), search, the names of the loaded tree suggested, and DBeaver's keys to run.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-code',
  template: '<div #host class="code-host"></div>',
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .code-host {
      height: 100%;
    }
  `,
})
export class DbSqlCode {
  /** The text it starts with; later changes come from typing or `replace`. */
  readonly text = input('');
  readonly cursor = input(0);
  readonly driver = input('');
  readonly label = input('SQL');
  readonly words = input<readonly string[]>([]);
  readonly changed = output<string>();
  readonly moved = output<number>();
  readonly action = output<SqlCommand>();
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: EditorView | undefined;
  private readonly language = new Compartment();
  private readonly completions = new Compartment();

  constructor() {
    afterNextRender(() => this.create());
    effect(() => {
      const driver = this.driver();
      untracked(() => void this.useDialect(driver));
    });
    effect(() => {
      const words = this.words();
      untracked(() =>
        this.view?.dispatch({ effects: this.completions.reconfigure(wordCompletions(words)) }),
      );
    });
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  private create() {
    const send = (command: SqlCommand) => () => {
      this.action.emit(command);
      return true;
    };
    const start = Math.min(this.cursor(), this.text().length);
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.text(),
        selection: { anchor: start },
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: send('run') },
              { key: 'Mod-\\', run: send('run-new') },
              { key: 'Alt-x', run: send('script') },
              { key: 'Mod-s', run: send('save') },
              { key: 'Mod-Alt-ArrowUp', run: send('previous') },
              { key: 'Mod-Alt-ArrowDown', run: send('next') },
            ]),
          ),
          ...baseExtensions({
            label: this.label(),
            placeholder: '',
            changed: (text) => this.changed.emit(text),
          }),
          foldGutter(),
          keymap.of(foldKeymap),
          ranField,
          ranTheme,
          this.language.of([]),
          this.completions.of(wordCompletions(this.words())),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet) this.moved.emit(update.state.selection.main.head);
          }),
        ],
      }),
    });
    void this.useDialect(this.driver());
  }

  private async useDialect(driver: string) {
    const support = await sqlSupport(driver);
    this.view?.dispatch({ effects: this.language.reconfigure(support) });
  }

  /** The selected text, or the cursor when nothing is selected. */
  selection(): { from: number; to: number; text: string } {
    const view = this.view;
    if (!view) return { from: 0, to: 0, text: '' };
    const { from, to } = view.state.selection.main;
    return { from, to, text: view.state.sliceDoc(from, to) };
  }
  content(): string {
    return this.view?.state.doc.toString() ?? this.text();
  }
  /** Marks the text that ran, until something else runs. */
  markRan(from: number, to: number) {
    this.view?.dispatch({ effects: setRan.of({ from, to }) });
  }
  /** Puts the cursor where an error of the server is. */
  goToOffset(offset: number) {
    const view = this.view;
    if (!view) return;
    const at = Math.min(Math.max(offset, 0), view.state.doc.length);
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  }
  /** Replaces the whole text, as opening an entry of the history does. */
  replace(text: string) {
    const view = this.view;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
    view.focus();
  }
  focus() {
    this.view?.focus();
  }
}
