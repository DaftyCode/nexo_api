import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import type { TransferOutcome, TransferProgress } from '../../application/mongo-use-cases';
import type { TransferSource } from '../../application/ports';
import { QueryForm } from '../../domain/mongo-query';
import {
  CsvColumn,
  ExportScope,
  ImportMode,
  JsonFlavour,
  TransferFormat,
  TransferValue,
  emptyTransfer,
} from '../../domain/mongo-transfer';

/** What the transfer dialog edits. */
export interface DraftModel {
  database: string;
  collection: string;
  format: TransferFormat;
  flavour: JsonFlavour;
  scope: ExportScope;
  /** Export: to a file, or to a collection of this or another connection. */
  destination: 'file' | 'collection';
  copyConnection: string;
  copyDatabase: string;
  copyCollection: string;
  mode: ImportMode;
  /** Upsert: the key fields, separated by commas. */
  keyText: string;
  /** Replace: the collection's name, repeated. */
  confirm: string;
  continueOnError: boolean;
  /** The name to save the transfer with. */
  name: string;
}

/** A preview of a file before importing it. */
export interface FilePreview {
  header: string[];
  rows: string[][];
  documents: Record<string, unknown>[];
}

/**
 * An import or export being prepared and then run: its settings, the CSV fields or columns,
 * the file chosen, and how the run goes.
 */
export class TransferDraft {
  readonly model: ReturnType<typeof signal<DraftModel>>;
  readonly fields;
  /** Export to CSV: the fields found, and those written in their order. */
  readonly available = signal<string[]>([]);
  readonly chosen = signal<string[]>([]);
  /** Import: the file chosen, its preview and its CSV columns. */
  readonly file = signal<TransferSource | undefined>(undefined);
  readonly preview = signal<FilePreview | undefined>(undefined);
  readonly columns = signal<CsvColumn[]>([]);
  readonly phase = signal<'setup' | 'running' | 'done'>('setup');
  readonly progress = signal<TransferProgress>({ documents: 0, bytes: 0, total: 0 });
  readonly outcome = signal<TransferOutcome | undefined>(undefined);
  readonly error = signal('');
  /** The share of the file read, for its progress bar. */
  readonly percent = computed(() => {
    const { bytes, total } = this.progress();
    return total ? Math.round((bytes / total) * 100) : undefined;
  });
  controller?: AbortController;
  /** Export of a query: its fields as typed. */
  readonly query: QueryForm;

  constructor(
    readonly direction: TransferValue['direction'],
    stored: TransferValue,
    injector: Injector,
    name = '',
  ) {
    this.model = signal<DraftModel>({
      database: stored.database,
      collection: stored.collection,
      format: stored.format,
      flavour: stored.flavour,
      scope: stored.scope,
      destination: stored.destination,
      copyConnection: stored.to.connection || stored.connection,
      copyDatabase: stored.to.database || stored.database,
      copyCollection: stored.to.collection,
      mode: stored.mode,
      keyText: stored.key.join(', '),
      confirm: '',
      continueOnError: stored.continueOnError,
      name,
    });
    this.fields = runInInjectionContext(injector, () => form(this.model));
    this.query = { ...stored.query };
    this.chosen.set([...stored.fields]);
    this.columns.set(stored.columns.map((column) => ({ ...column })));
  }

  /** The key fields of an upsert. */
  key(): string[] {
    return this.model()
      .keyText.split(',')
      .map((field) => field.trim())
      .filter(Boolean);
  }

  /** The transfer as it is saved, to run it again. */
  value(connection: string): TransferValue {
    const m = this.model();
    return {
      ...emptyTransfer(this.direction, connection, m.database, m.collection),
      format: m.format,
      flavour: m.flavour,
      scope: m.scope,
      query: { ...this.query },
      fields: [...this.chosen()],
      destination: m.destination,
      to: { connection: m.copyConnection, database: m.copyDatabase, collection: m.copyCollection },
      columns: this.columns().map((column) => ({ ...column })),
      mode: m.mode,
      key: this.key(),
      continueOnError: m.continueOnError,
    };
  }

  /** Moves a CSV field one place up (-1) or down (1). */
  moveField(field: string, offset: -1 | 1) {
    const list = [...this.chosen()];
    const index = list.indexOf(field);
    const to = index + offset;
    if (index < 0 || to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    this.chosen.set(list);
  }
  /** Adds a CSV field at the end, or removes it. */
  toggleField(field: string, on: boolean) {
    this.chosen.update((list) =>
      on
        ? [...list.filter((item) => item !== field), field]
        : list.filter((item) => item !== field),
    );
  }

  /** Columns for a CSV header: each to the field of its name, its type guessed. */
  columnsFor(header: readonly string[]) {
    const kept = new Map(this.columns().map((column) => [column.column, column]));
    this.columns.set(
      header.map((column) => kept.get(column) ?? { column, field: column, type: 'auto' }),
    );
  }
  setColumn(index: number, change: Partial<CsvColumn>) {
    this.columns.update((columns) =>
      columns.map((column, i) => (i === index ? { ...column, ...change } : column)),
    );
  }
}
