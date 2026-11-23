import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CodeEditor } from './code-editor';
import { DataGrid } from './data-grid/data-grid';
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
import { gridColumns, gridRows } from '../domain/mongo/grid';

export type ResultsView = 'table' | 'tree' | 'json';
export type JsonFormat = 'shell' | 'relaxed' | 'canonical';
type Path = readonly (string | number)[];

/** A write the person asked for on what is selected. */
export interface ResultsEdit {
  action: 'edit' | 'unset' | 'duplicate' | 'delete';
  /** The document of the results the selection belongs to. */
  document: Record<string, unknown>;
  /** The selected value's path in that document; empty for the document itself. */
  path: Path;
  value: unknown;
}

/** Where the table is: the page, or an array inside one of its documents. */
interface Step {
  row: number;
  path: Path;
  label: string;
}

/** Rows painted at once in the tree; more on request (the table is the virtualized grid). */
const PAINTED = 100;

/** A value as the chosen format writes it. */
export function formatValue(value: unknown, format: JsonFormat): string {
  if (format === 'shell') return shell(value);
  return JSON.stringify(format === 'relaxed' ? relaxed(value) : value, null, 2);
}

/**
 * The documents of a page as a table (the data grid of the databases, DB-41: embedded
 * documents opened as columns and arrays entered as tables of their own, with a double click
 * or Enter), a tree, or JSON in the shell's syntax or Extended JSON. Every value shows its BSON
 * type and can be copied.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor, DataGrid],
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
  /** Whether the connection may write: the write actions are shown. */
  readonly writable = input(false);
  /** What the last copy did, as a message key. */
  readonly copied = output<string>();
  readonly edit = output<ResultsEdit>();
  private readonly i18n = inject(TranslocoService);

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
  /** The table as the grid takes it: a column per field, each value by its BSON type. */
  protected readonly gridColumns = computed(() =>
    gridColumns(this.rows(), this.columns(), this.i18n.translate('Value')),
  );
  protected readonly gridRows = computed(() => gridRows(this.rows(), this.columns()));
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

  protected typeClass(type: BsonType | undefined) {
    return type ? `bson-${type.toLowerCase()}` : 'bson-missing';
  }
  /** The BSON type of a cell of the table. */
  private typeAt(row: number, column: number): BsonType | undefined {
    const value = valueAt(this.rows()[row], this.columns()[column]?.path ?? []);
    return value === undefined ? undefined : bsonType(value);
  }
  /** A document opens into columns and an array is entered, with a double click or Enter. */
  protected readonly opens = (row: number, column: number) => {
    const type = this.typeAt(row, column);
    return type === 'Document' || type === 'Array';
  };
  protected opened(cell: { row: number; column: number }) {
    this.open(cell.row, this.columns()[cell.column], this.typeAt(cell.row, cell.column));
  }
  /** The cell the person is on, or the whole document when its row was chosen. */
  protected chosen(cell: { row: number; column: number; whole: boolean }) {
    const path = cell.whole ? [] : (this.columns()[cell.column]?.path ?? []);
    this.selected.set({ row: cell.row, path });
  }
  /** What the chosen value opens: its fields as columns, or its elements as a table. */
  protected readonly opening = computed(() => {
    const choice = this.choice();
    if (!choice?.path.length) return undefined;
    return choice.type === 'Document' ? 'open' : choice.type === 'Array' ? 'enter' : undefined;
  });
  /** The embedded document opened into columns that the chosen value belongs to. */
  protected readonly closing = computed(() => {
    const parent = this.choice()?.path.slice(0, -1).join('.');
    return parent && this.expanded().has(parent) ? parent : undefined;
  });
  protected openChosen() {
    const choice = this.choice();
    const column = this.columns().find((each) => each.path.join('.') === choice?.path.join('.'));
    if (choice && column) this.open(choice.row, column, choice.type);
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
  /** A document opens its column; an array is entered. */
  private open(row: number, column: TableColumn | undefined, type: BsonType | undefined) {
    if (!column) return;
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
      return;
    }
  }
  protected leave(depth: number) {
    this.steps.update((steps) => steps.slice(0, depth));
    this.selected.set(undefined);
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

  /**
   * The selection in its document of the results: inside arrays that were entered, the path
   * goes through each of them.
   */
  protected readonly target = computed(() => {
    const choice = this.choice();
    if (!choice) return undefined;
    const steps = this.steps();
    if (!steps.length)
      return { document: this.documents()[choice.row], path: choice.path, value: choice.value };
    const path: (string | number)[] = [...steps[0].path];
    for (const step of steps.slice(1)) path.push(step.row, ...step.path);
    path.push(choice.row, ...choice.path);
    return { document: this.documents()[steps[0].row], path, value: choice.value };
  });
  protected request(action: ResultsEdit['action']) {
    const target = this.target();
    if (target) this.edit.emit({ action, ...target });
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
