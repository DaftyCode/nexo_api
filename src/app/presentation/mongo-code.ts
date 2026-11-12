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
  CODE_LANGUAGES,
  CodeLanguage,
  CodeQuery,
  CodegenError,
  generateCode,
} from '../domain/mongo-codegen';
import { CodeEditor } from './code-editor';
import { WorkspaceState, named } from './workspace-state';

/**
 * Driver code for the query or the pipeline shown: a whole program in the language chosen,
 * which reads the connection from `MONGODB_URI`, to copy or download.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-code',
  styleUrls: ['./mongo-dialog.scss'],
  templateUrl: './mongo-code.html',
  host: { '(keydown.escape)': 'closed.emit()' },
})
export class MongoCode {
  readonly query = input.required<CodeQuery>();
  readonly closed = output<void>();
  private readonly state = inject(WorkspaceState);
  private readonly files = inject(TRANSFER_FILES);
  protected readonly languages = CODE_LANGUAGES;
  protected readonly language = signal<CodeLanguage>('mongosh');
  protected readonly copied = signal(false);
  /** The program, or why a value cannot be written in this language. */
  protected readonly generated = computed(() => {
    try {
      return { code: generateCode(this.language(), this.query()) };
    } catch (error) {
      if (error instanceof CodegenError) return { code: '', error };
      throw error;
    }
  });
  protected readonly editorLanguage = computed(() =>
    this.language() === 'mongosh' || this.language() === 'node' ? 'javascript' : 'text',
  );

  protected choose(event: Event) {
    this.language.set((event.target as HTMLSelectElement).value as CodeLanguage);
    this.copied.set(false);
  }
  protected async copy() {
    await globalThis.navigator?.clipboard?.writeText(this.generated().code);
    this.copied.set(true);
  }
  protected async download() {
    const { file } = CODE_LANGUAGES.find((language) => language.id === this.language())!;
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
