import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DEFAULT_VALUE, columnName } from '../domain/db/edits';
import { ResultColumn } from '../domain/db/results';
import { parseExpression } from '../domain/db/virtual-columns';
import { RowEditor } from './db-panel/row-editor';
import { StudioIcon } from './studio-icon';

/** The cell actions a grid offers while its rows can be edited. */
export const EDIT_ACTIONS = [
  { id: 'edit.add', label: 'Add a row' },
  { id: 'edit.duplicate', label: 'Duplicate the rows' },
  { id: 'edit.delete', label: 'Delete the rows' },
  { id: 'edit.null', label: 'Set to NULL' },
  { id: 'edit.default', label: 'Set to its default' },
  { id: 'edit.file', label: 'Load a file into the cell' },
] as const;

/** A file chosen in the browser, as a binary value. */
function chooseFile(): Promise<unknown> {
  return new Promise((done) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return done(undefined);
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        done({ $t: 'binary', v: url.slice(url.indexOf(',') + 1) });
      };
      reader.onerror = () => done(undefined);
      reader.readAsDataURL(file);
    });
    input.addEventListener('cancel', () => done(undefined));
    input.click();
  });
}

/** Does what an edit action of a grid's menu asks, on the rows its selection spans. */
export function editAction(
  editor: RowEditor,
  event: { action: string; column: number; rows: readonly number[] },
) {
  const rows = event.rows.length ? event.rows : [];
  switch (event.action) {
    case 'edit.add':
      return editor.addRow();
    case 'edit.duplicate':
      return editor.duplicate(rows);
    case 'edit.delete':
      return editor.remove(rows);
    case 'edit.null':
      return editor.setValue(rows, event.column, null);
    case 'edit.default':
      return editor.setValue(rows, event.column, DEFAULT_VALUE);
    case 'edit.file':
      return void chooseFile().then(
        (value) => value !== undefined && editor.setValue(rows, event.column, value),
      );
  }
}

/**
 * The editing tools of a grid of rows, as DBeaver's data editor: add a row, save what is
 * pending (with its count), undo, discard and see the script; optimistic locking; and, when
 * the rows cannot be edited, why, with a virtual key to choose for a table without one.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-row-edits',
  templateUrl: './db-row-edits.html',
  styleUrl: './db-row-edits.scss',
})
export class DbRowEdits {
  readonly editor = input.required<RowEditor>();
  readonly columns = input.required<readonly ResultColumn[]>();
  /** Offer columns computed in the interface (the «Data» tab of a table). */
  readonly virtualColumns = input(false);
  protected readonly choosingColumns = signal(false);
  protected readonly draft = signal({ name: '', expression: '', error: '' });
  protected readonly choosingKey = signal(false);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly names = computed(() => this.columns().map(columnName));

  protected toggle(name: string) {
    this.chosen.update((chosen) => {
      const next = new Set(chosen);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }
  protected setDraft(field: 'name' | 'expression', text: string) {
    this.draft.update((draft) => ({ ...draft, [field]: text, error: '' }));
  }
  /** Adds the virtual column being written, once its expression reads. */
  protected async addColumn() {
    const { name, expression } = this.draft();
    try {
      parseExpression(expression);
    } catch {
      return this.draft.update((draft) => ({ ...draft, error: 'db.virtual.invalid' }));
    }
    if (!name.trim()) return;
    await this.editor().setVirtualColumns([
      ...this.editor().virtual(),
      { name: name.trim(), expression },
    ]);
    this.draft.set({ name: '', expression: '', error: '' });
  }
  protected async removeColumn(name: string) {
    await this.editor().setVirtualColumns(
      this.editor()
        .virtual()
        .filter((column) => column.name !== name),
    );
  }

  protected async saveKey() {
    const columns = this.names().filter((name) => this.chosen().has(name));
    this.choosingKey.set(false);
    if (columns.length) await this.editor().setVirtualKey(columns);
  }
}
