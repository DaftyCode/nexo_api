import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, input, model } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { KeyValue, fileNames, row } from '../domain/models';
import { WorkspaceState } from './workspace-state';

@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-key-value-editor',
  styleUrl: './key-value-editor.scss',
  templateUrl: './key-value-editor.html',
})
export class KeyValueEditor {
  readonly rows = model<KeyValue[]>([row()]);
  /** Rows whose keys come from elsewhere (the URL path variables): only values are edited. */
  readonly fixedKeys = input(false);
  /** Form-data rows: each one sends text or files, as in Postman. */
  readonly files = input(false);
  private readonly state = inject(WorkspaceState);
  protected readonly fields = form(this.rows);
  protected add() {
    this.rows.update((rows) => [...rows, row()]);
  }
  protected remove(index: number) {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
  }
  private change(index: number, change: (row: KeyValue) => KeyValue) {
    this.rows.update((rows) => rows.map((row, i) => (i === index ? change(row) : row)));
  }
  /** Text or File: switching starts the row empty. */
  protected setType(index: number, event: Event) {
    const file = (event.target as HTMLSelectElement).value === 'file';
    this.change(index, ({ type: _type, src: _src, files: _files, ...row }) =>
      file ? { ...row, value: '', type: 'file', src: '' } : { ...row, value: '' },
    );
  }
  /** Reads the files chosen for a row; they are sent with the request but never saved. */
  protected async choose(index: number, event: Event) {
    const target = event.target as HTMLInputElement;
    const chosen = [...(target.files ?? [])];
    target.value = '';
    if (!chosen.length) return;
    try {
      const files = await Promise.all(chosen.map((file) => this.state.cases.attachFile(file)));
      this.change(index, (row) => ({
        ...row,
        type: 'file',
        src: files.length === 1 ? files[0].name : files.map((file) => file.name),
        files,
      }));
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  /** What a file row shows: the files chosen, or the names to choose again after opening it. */
  protected fileState(row: KeyValue): { names: string; missing: boolean; kilobytes: string } {
    const names = fileNames(row);
    const files = row.files ?? [];
    const size = files.reduce((total, file) => total + file.size, 0);
    return {
      names: names.join(', '),
      missing: names.length > files.length,
      kilobytes: (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0),
    };
  }
}
