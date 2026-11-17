import { signal } from '@angular/core';
import { RowMark, isDefault } from '../../domain/db/edits';
import { tsvBlock } from '../../domain/db/edits-sql';

/**
 * What the screen around a grid lets it edit: the rows it shows already carry the changes;
 * the grid asks to change a cell (from what was typed) and to paste a block of cells.
 */
export interface GridEditing {
  /** Why the rows cannot be edited (a message key), or empty when they can. */
  reason(): string;
  mark(row: number): RowMark | undefined;
  /** Sets a cell from what was typed; answers why it does not fit (a message key), or ''. */
  edit(row: number, column: number, text: string): string;
  /** Pastes rows of cells from the active one on; answers why they do not fit, or ''. */
  paste(row: number, column: number, block: string[][]): string;
}

/** The text a cell is edited from. */
export function editText(value: unknown): string {
  if (value === null || value === undefined || isDefault(value)) return '';
  if (typeof value === 'object' && 'v' in (value as object))
    return String((value as { v: unknown }).v);
  return String(value);
}

/** The cell being edited: its row among those given, its column, the text and its error. */
export interface EditingCell {
  row: number;
  column: number;
  text: string;
  error: string;
}

/**
 * The cell editor of a grid, as DBeaver's: F2, Enter or a character typed edit the active
 * cell in place; Enter keeps the text, Escape leaves it; Ctrl+V pastes a block.
 */
export class GridCellEditor {
  readonly at = signal<EditingCell | undefined>(undefined);

  constructor(
    private readonly deps: {
      editing: () => GridEditing | undefined;
      active: () => { row: number; column: number; value: unknown } | undefined;
      focus: () => void;
      /** The input of the cell being edited, once it is drawn. */
      input: () => HTMLInputElement | null | undefined;
    },
  ) {}

  enabled() {
    const editing = this.deps.editing();
    return !!editing && !editing.reason();
  }
  editingAt(row: number, column: number) {
    const at = this.at();
    return !!at && at.row === row && at.column === column;
  }

  start(initial?: string) {
    const active = this.deps.active();
    if (!active || !this.enabled()) return;
    const text = initial ?? editText(active.value);
    this.at.set({ row: active.row, column: active.column, text, error: '' });
    setTimeout(() => {
      const input = this.deps.input();
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  }
  commit(text: string) {
    const at = this.at();
    const editing = this.deps.editing();
    if (!at || !editing) return;
    const error = editing.edit(at.row, at.column, text);
    if (error) return this.at.set({ ...at, text, error });
    this.at.set(undefined);
    this.deps.focus();
  }
  cancel() {
    this.at.set(undefined);
    this.deps.focus();
  }

  /** A key of the grid that starts editing: answers whether it took it. */
  key(event: KeyboardEvent): boolean {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const at = this.at();
    // Typed before its input takes the focus: it goes to the text all the same.
    if (at && plain && event.key.length === 1) {
      event.preventDefault();
      this.at.set({ ...at, text: at.text + event.key });
      return true;
    }
    if (!this.enabled() || at) return false;
    if (event.key === 'F2' || (event.key === 'Enter' && plain)) {
      event.preventDefault();
      this.start();
      return true;
    }
    if (plain && event.key.length === 1) {
      event.preventDefault();
      this.start(event.key);
      return true;
    }
    return false;
  }

  /** Pastes the clipboard's cells from the active one on. */
  async paste() {
    const active = this.deps.active();
    const editing = this.deps.editing();
    if (!active || !editing || !this.enabled()) return '';
    const text = await globalThis.navigator?.clipboard?.readText();
    return text ? editing.paste(active.row, active.column, tsvBlock(text)) : '';
  }
}
