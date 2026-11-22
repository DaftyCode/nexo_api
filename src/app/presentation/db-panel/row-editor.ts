import { computed, signal } from '@angular/core';
import { autoCommits, readDbConnection, tableKey } from '../../domain/db/connection';
import {
  EditHistory,
  addRow,
  changeCount,
  deleteRows,
  duplicateRows,
  editability,
  marks,
  noEdits,
  rowChanges,
  setCell,
  shownRows,
  undo,
} from '../../domain/db/edits';
import { editScript, parseInput } from '../../domain/db/edits-sql';
import { VirtualColumn, withVirtualColumns } from '../../domain/db/virtual-columns';
import { ResultColumn } from '../../domain/db/results';
import { success } from '../workspace-state';
import type { GridEditing } from '../data-grid/cell-editor';
import type { DbSection } from './section';

/** Deleted rows a save confirms first, as the backend demands. */
const MANY_DELETED = 100;

/** What a grid of rows gives its editor: its rows, where they come from, and how to read them again. */
export interface EditedRows {
  columns(): readonly ResultColumn[];
  rows(): readonly (readonly unknown[])[];
  connection(): string;
  session(): string;
  /** Reads the rows again once saved: generated values and triggers show. */
  reload(): Promise<void>;
}

/** A question before saving: production, or many deleted rows. */
export interface SaveQuestion {
  message: string;
  params?: Record<string, string>;
  answer: (ok: boolean) => void;
}

/**
 * The rows of a grid edited before they are saved, as DBeaver's data editor: changed cells,
 * new and deleted rows kept pending (marked in the grid, undoable), the script a save would
 * run, and the save itself, written as one by the driver (`db.rows.write`).
 */
export class RowEditor implements GridEditing {
  readonly history = signal<EditHistory>(noEdits());
  /** Also compare the original values of what changed, not to overwrite another's change. */
  readonly optimistic = signal(false);
  readonly saving = signal(false);
  readonly question = signal<SaveQuestion | undefined>(undefined);
  /** The script a save would run, while it is shown. */
  readonly script = signal<string | undefined>(undefined);

  constructor(
    private readonly section: DbSection,
    private readonly source: EditedRows,
  ) {}

  private value() {
    return readDbConnection(this.section.connection(this.source.connection())?.value);
  }
  /** Whether the rows can be edited: the table and key they are written with, or why not. */
  readonly check = computed(() => {
    const value = this.value();
    const origin = this.source.columns()[0]?.origin;
    const key = origin?.table
      ? value.virtualKeys?.[tableKey(origin.table, origin.schema)]
      : undefined;
    return editability(this.source.columns(), {
      readOnly: !!value.readOnly,
      ...(key ? { virtualKey: key } : {}),
    });
  });
  readonly shown = computed(() => shownRows(this.source.rows(), this.history().now));
  private readonly marked = computed(() => marks(this.source.rows().length, this.history().now));
  readonly count = computed(() => changeCount(this.history().now));
  /** The table the rows come from, as its virtual key and columns are kept. */
  private readonly tableName = computed(() => {
    const origin = this.source.columns()[0]?.origin;
    return origin?.table ? tableKey(origin.table, origin.schema) : '';
  });
  readonly virtual = computed(() => this.value().virtualColumns?.[this.tableName()] ?? []);
  /** What the grid shows: the rows with their changes, then the virtual columns. */
  readonly grid = computed(() =>
    withVirtualColumns(this.source.columns(), this.shown(), this.virtual()),
  );

  reason() {
    return this.check().reason ?? '';
  }
  mark(row: number) {
    return this.marked().get(row);
  }
  edit(row: number, column: number, text: string): string {
    if (column >= this.source.columns().length) return 'db.virtual.readOnly';
    const parsed = parseInput(text, this.source.columns()[column]);
    if (parsed.error !== undefined) return parsed.error;
    this.history.update((history) =>
      setCell(history, this.source.rows().length, row, column, parsed.value),
    );
    return '';
  }
  paste(row: number, column: number, block: string[][]): string {
    const columns = this.source.columns();
    let next = this.history();
    for (const [down, cells] of block.entries())
      for (const [across, text] of cells.entries()) {
        const at = column + across;
        if (at >= columns.length || row + down >= this.shown().length) continue;
        const parsed = parseInput(text, columns[at]);
        if (parsed.error !== undefined) return parsed.error;
        next = setCell(next, this.source.rows().length, row + down, at, parsed.value);
      }
    // One step to undo, however many cells.
    this.history.set({ now: next.now, past: [this.history().now, ...this.history().past] });
    return '';
  }

  /** A value for the cells of some rows in a column: `NULL` or the column's default. */
  setValue(rows: readonly number[], column: number, value: unknown) {
    if (column >= this.source.columns().length) return;
    let next = this.history();
    for (const row of rows) next = setCell(next, this.source.rows().length, row, column, value);
    this.history.set(next);
  }
  addRow() {
    this.history.update((history) => addRow(history, this.source.columns().length));
  }
  duplicate(rows: readonly number[]) {
    const key = this.check().target?.key ?? [];
    this.history.update((history) => duplicateRows(history, this.shown(), rows, key));
  }
  remove(rows: readonly number[]) {
    this.history.update((history) => deleteRows(history, this.source.rows().length, rows));
  }
  undo() {
    this.history.update(undo);
  }
  discard() {
    this.history.set(noEdits());
  }

  private changes() {
    const target = this.check().target;
    if (!target) return undefined;
    const changes = rowChanges(
      this.source.columns(),
      this.source.rows(),
      this.history().now,
      target,
    );
    return { target, changes };
  }
  /** Shows the script a save would run, with its values in line. */
  showScript() {
    const found = this.changes();
    const style = this.section.sqlStyle(this.source.connection());
    this.script.set(found ? editScript(found.target, found.changes, style) : '');
  }

  private ask(message: string, params?: Record<string, string>): Promise<boolean> {
    return new Promise((done) =>
      this.question.set({
        message,
        ...(params ? { params } : {}),
        answer: (ok) => {
          this.question.set(undefined);
          done(ok);
        },
      }),
    );
  }

  /** Saves what is pending as one; on production, or many rows deleted, it asks first. */
  async save() {
    const found = this.changes();
    if (!found || !found.changes.length || this.saving()) return;
    const deleted = found.changes.filter((change) => change.kind === 'delete').length;
    const rules = this.section.rulesOf(this.source.connection());
    const production = rules.confirmWrites;
    let confirm = false;
    if (production || deleted > MANY_DELETED) {
      const message = production ? 'db.edit.confirmProduction' : 'db.edit.confirmDeletes';
      if (!(await this.ask(message, { v0: String(found.changes.length), v1: String(deleted) })))
        return;
      confirm = true;
    }
    this.saving.set(true);
    try {
      const cases = await this.section.cases();
      const written = await cases.statements.writeRows(
        this.section.state.workspaceId(),
        this.source.session(),
        {
          ...(found.target.schema ? { schema: found.target.schema } : {}),
          table: found.target.table,
          changes: found.changes,
          optimistic: this.optimistic(),
          confirm,
        },
      );
      this.discard();
      const manual = !autoCommits(this.value(), rules);
      this.section.state.tell(
        success(manual ? 'db.edit.savedPending' : 'db.edit.saved', 'db.edit.rows', {
          v0: String(written.affected),
        }),
      );
      await this.source.reload();
    } catch (error) {
      this.section.state.tell({
        kind: 'error',
        title: 'db.edit.notSaved',
        detail: this.section.state.describe(error),
      });
    } finally {
      this.saving.set(false);
    }
  }

  /** Keeps the columns that name each row of a table without a key, in its connection. */
  async setVirtualKey(columns: readonly string[]) {
    await this.keep((value, table) => ({
      ...value,
      virtualKeys: { ...value.virtualKeys, [table]: [...columns] },
    }));
  }
  /** Keeps the table's virtual columns in its connection. */
  async setVirtualColumns(columns: readonly VirtualColumn[]) {
    await this.keep((value, table) => {
      const all = { ...value.virtualColumns, [table]: [...columns] };
      if (!columns.length) delete all[table];
      return { ...value, virtualColumns: all };
    });
  }
  private async keep(
    change: (
      value: ReturnType<typeof readDbConnection>,
      table: string,
    ) => ReturnType<typeof readDbConnection>,
  ) {
    const document = this.section.connection(this.source.connection());
    if (!this.tableName() || !document) return;
    const value = readDbConnection(document.value);
    const cases = await this.section.cases();
    await cases.connections.update(document, document.name, change(value, this.tableName()));
    await this.section.state.refresh();
  }
}
