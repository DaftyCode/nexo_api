import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TRANSFER_FILES } from '../composition/providers';
import {
  SQL_CODE_LANGUAGES,
  SqlCodeLanguage,
  SqlCodeQuery,
  SqlCodegenError,
  copyAsString,
  generateSqlCode,
  pasteFromCode,
} from '../domain/db/sql-codegen';
import { CodeEditor } from './code-editor';
import { WorkspaceState, named } from './workspace-state';

/** The language chosen last, while the app is open. */
let chosen: SqlCodeLanguage = 'node';

/**
 * Code that runs a SQL statement (DB-33): a whole program in the language chosen, which
 * reads the connection from `DATABASE_URL`, to copy or download; the statement alone as a
 * string of that language; and, from the editor, a string pasted from a program turned back
 * into the statement.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-query-code',
  styleUrls: ['./mongo-dialog.scss'],
  templateUrl: './db-query-code.html',
  host: { '(keydown.escape)': 'closed.emit()' },
})
export class DbQueryCode {
  readonly query = input.required<SqlCodeQuery>();
  /** Puts a statement in the editor; absent where there is no editor. */
  readonly paste = input<(sql: string) => void>();
  readonly closed = output<void>();
  private readonly state = inject(WorkspaceState);
  private readonly files = inject(TRANSFER_FILES);
  protected readonly languages = SQL_CODE_LANGUAGES;
  protected readonly language = signal<SqlCodeLanguage>(chosen);
  protected readonly copied = signal<'' | 'program' | 'string'>('');
  protected readonly pasted = signal('');
  protected readonly statement = computed(() => pasteFromCode(this.pasted()).trim());
  /** The program, or why it cannot be written for this engine. */
  protected readonly generated = computed(() => {
    try {
      return { code: generateSqlCode(this.language(), this.query()) };
    } catch (error) {
      if (error instanceof SqlCodegenError) return { code: '', error };
      throw error;
    }
  });
  protected readonly editorLanguage = computed(() =>
    this.language() === 'node' ? 'javascript' : 'text',
  );

  protected choose(event: Event) {
    chosen = (event.target as HTMLSelectElement).value as SqlCodeLanguage;
    this.language.set(chosen);
    this.copied.set('');
  }
  protected async copy(what: 'program' | 'string') {
    const text =
      what === 'program'
        ? this.generated().code
        : copyAsString(this.language(), this.query().sql.trim());
    await globalThis.navigator?.clipboard?.writeText(text);
    this.copied.set(what);
  }
  protected typed(event: Event) {
    this.pasted.set((event.target as HTMLTextAreaElement).value);
  }
  protected put() {
    const statement = this.statement();
    if (!statement) return;
    this.paste()?.(statement);
    this.closed.emit();
  }
  protected async download() {
    const { file } = SQL_CODE_LANGUAGES.find((language) => language.id === this.language())!;
    const extension = file.split('.').pop() ?? 'txt';
    await this.state.announce('The code could not be saved', async () => {
      const target = await this.files.save(file, extension, 'text/plain');
      if (!target) return undefined;
      await target.write(this.generated().code);
      await target.close();
      return named('Code saved', target.name);
    });
  }
}
