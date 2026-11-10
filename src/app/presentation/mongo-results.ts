import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CodeEditor } from './code-editor';
import {
  BsonType,
  TableColumn,
  bsonType,
  objectIdDate,
  relaxed,
  shell,
  summary,
  tableColumns,
  treeRows,
  valueAt,
} from '../domain/bson';

export type ResultsView = 'table' | 'tree' | 'json';
export type JsonFormat = 'shell' | 'relaxed' | 'canonical';
type Path = readonly (string | number)[];

/** Where the table is: the page, or an array inside one of its documents. */
interface Step {
  row: number;
  path: Path;
  label: string;
}

/** Rows painted at once in the table and the tree; more on request. */
const PAINTED = 100;

/** A value as the chosen format writes it. */
export function formatValue(value: unknown, format: JsonFormat): string {
  if (format === 'shell') return shell(value);
  return JSON.stringify(format === 'relaxed' ? relaxed(value) : value, null, 2);
}

/**
 * The documents of a page as a table (embedded documents opened as columns, arrays entered
 * as tables of their own), a tree, or JSON in the shell's syntax or Extended JSON. Every
 * value shows its BSON type and can be copied.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-results',
  styleUrl: './mongo-results.scss',
  templateUrl: './mongo-results.html',
})
export class MongoResults {
  readonly documents = input.required<readonly Record<string, unknown>[]>();
  /** Position of the first document in the results, to number the rows. */
  readonly offset = input(0);
  readonly view = input<ResultsView>('table');
  readonly format = input<JsonFormat>('shell');
  /** What the last copy did, as a message key. */
  readonly copied = output<string>();

  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly steps = signal<readonly Step[]>([]);
  protected readonly treeOpen = signal<ReadonlySet<string>>(new Set());
  protected readonly painted = signal(PAINTED);
  /** The value chosen to copy: a document (`path` empty) or one of its values. */
  protected readonly selected = signal<{ row: number; path: Path } | undefined>(undefined);

  constructor() {
    // A new page starts at its documents, with nothing selected.
    effect(() => {
      this.documents();
      untracked(() => {
        this.steps.set([]);
        this.treeOpen.set(new Set());
        this.painted.set(PAINTED);
        this.selected.set(undefined);
      });
    });
  }

  /** The rows of the table: the documents, or the elements of the array entered. */
  protected readonly rows = computed<readonly unknown[]>(() => {
    let rows: readonly unknown[] = this.documents();
    for (const step of this.steps()) {
      const value = valueAt(rows[step.row], step.path);
      rows = Array.isArray(value) ? value : [];
    }
    return rows;
  });
  protected readonly columns = computed<TableColumn[]>(() => {
    const rows = this.rows();
    const columns = tableColumns(rows, this.expanded());
    // Elements that are not documents (numbers, strings…) have a column of their own.
    if (rows.some((row) => bsonType(row) !== 'Document'))
      columns.unshift({ path: [], label: '', expandable: false });
    return columns;
  });
  protected readonly shownRows = computed(() => this.rows().slice(0, this.painted()));
  protected readonly tree = computed(() => treeRows(this.documents(), this.treeOpen()));
  protected readonly shownTree = computed(() => this.tree().slice(0, this.painted()));
  protected readonly json = computed(() => {
    const format = this.format();
    const documents = this.documents();
    if (format === 'shell') return `[\n${documents.map((d) => '  ' + shell(d, 1)).join(',\n')}\n]`;
    return formatValue(documents, format);
  });
  protected readonly language = computed(() => (this.format() === 'shell' ? 'javascript' : 'json'));

  /** The selected value and what it is. */
  protected readonly choice = computed(() => {
    const selected = this.selected();
    if (!selected) return undefined;
    const document = this.steps().length
      ? this.rows()[selected.row]
      : this.documents()[selected.row];
    const value = valueAt(document, selected.path);
    const type = bsonType(value);
    const oid = type === 'ObjectId' ? summary(value) : undefined;
    return {
      ...selected,
      value,
      type,
      label: selected.path.join('.'),
      created: oid ? objectIdDate(oid) : undefined,
    };
  });

  protected cell(row: unknown, column: TableColumn) {
    const value = valueAt(row, column.path);
    return {
      missing: value === undefined,
      value,
      type: value === undefined ? undefined : bsonType(value),
      text: value === undefined ? '' : summary(value),
    };
  }
  /** A row's number: its place in the results, or in the array entered (from 1). */
  protected rowNumber(index: number) {
    return this.steps().length ? index + 1 : this.offset() + index + 1;
  }
  protected typeClass(type: BsonType | undefined) {
    return type ? `bson-${type.toLowerCase()}` : 'bson-missing';
  }

  /** Opens an embedded document into columns, or closes it with the ones opened inside. */
  protected toggle(column: string) {
    this.expanded.update((expanded) => {
      const next = new Set(expanded);
      if (next.has(column)) {
        for (const label of [...next])
          if (label === column || label.startsWith(`${column}.`)) next.delete(label);
      } else next.add(column);
      return next;
    });
  }
  /** The document opened into columns that starts at this column, to close it from there. */
  protected openedAt(index: number): string | undefined {
    const columns = this.columns();
    const parent = (column: TableColumn | undefined) => column?.path.slice(0, -1).join('.') ?? '';
    const opened = parent(columns[index]);
    return opened && parent(columns[index - 1]) !== opened ? opened : undefined;
  }
  /** A cell with a document opens its column; one with an array is entered. */
  protected open(row: number, column: TableColumn, type: BsonType | undefined) {
    if (type === 'Document') {
      if (!this.expanded().has(column.label)) this.toggle(column.label);
      return;
    }
    if (type === 'Array') {
      this.steps.update((steps) => [
        ...steps,
        { row, path: column.path, label: column.label || `[${row}]` },
      ]);
      this.selected.set(undefined);
      this.painted.set(PAINTED);
      return;
    }
    this.selected.set({ row, path: column.path });
  }
  protected leave(depth: number) {
    this.steps.update((steps) => steps.slice(0, depth));
    this.selected.set(undefined);
    this.painted.set(PAINTED);
  }
  protected selectRow(row: number) {
    this.selected.set({ row, path: [] });
  }
  protected selectTree(row: { document: number; path: Path; expandable: boolean; id: string }) {
    this.selected.set({ row: row.document, path: row.path });
    if (row.expandable) this.toggleTree(row.id);
  }
  protected toggleTree(id: string) {
    this.treeOpen.update((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  protected paintMore() {
    this.painted.update((count) => count + PAINTED);
  }

  protected async copyDocument() {
    const choice = this.choice();
    if (!choice) return;
    const row = this.steps().length ? this.rows()[choice.row] : this.documents()[choice.row];
    await this.copy(formatValue(row, this.format()), 'Document copied');
  }
  protected async copyValue() {
    const choice = this.choice();
    if (!choice) return;
    const text =
      choice.type === 'String' ? String(choice.value) : formatValue(choice.value, this.format());
    await this.copy(text, 'Value copied');
  }
  protected async copyCreated() {
    const created = this.choice()?.created;
    if (created) await this.copy(created, 'Date of the ObjectId copied');
  }
  private async copy(text: string, message: string) {
    await globalThis.navigator?.clipboard?.writeText(text);
    this.copied.emit(message);
  }
}
