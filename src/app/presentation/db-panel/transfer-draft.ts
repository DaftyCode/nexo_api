import { Injector, WritableSignal, computed, signal } from '@angular/core';
import { FieldTree, form } from '@angular/forms/signals';
import { TransferOutcome } from '../../application/database-use-cases';
import { TransferFilesPort, TransferSource } from '../../application/ports';
import { readDbConnection } from '../../domain/db/connection';
import { ResultColumn } from '../../domain/db/results';
import { quoteName } from '../../domain/db/tree';
import {
  FILE_EXTENSIONS,
  FILE_TYPES,
  FileFormat,
  defaultExportOptions,
} from '../../domain/db/transfer/export';
import { FileColumn } from '../../domain/db/transfer/import';
import type { DbSection } from './section';
import { TransferRequest } from './transfer-request';
import { TransferRun } from './transfer-run';

/** What the wizard asks, in one model for its form. */
export function transferModel(request: TransferRequest) {
  return {
    ...defaultExportOptions(),
    format: request.format ?? ('csv' as FileFormat),
    /** Export: the masking set the rows go through (empty: none). */
    mask: '',
    /** SQL: write a `CREATE TABLE` first, for this engine (empty: the source's). */
    createTable: false,
    dialect: '',
    /** Import: the file's format and whether it goes into a table created from it. */
    fileFormat: 'csv' as 'csv' | 'json',
    newTable: !request.table,
    /** Import into a new table, or copy: the target table. */
    table: request.table?.name ?? request.name,
    trim: true,
    emptyAsNull: true,
    /** Copy: the target connection, and whether its table is created. */
    target: '',
    create: true,
    mode: 'insert' as 'insert' | 'upsert',
    key: '',
    clear: false,
    clearName: '',
    stopOnError: true,
  };
}
export type TransferModel = ReturnType<typeof transferModel>;

/**
 * The transfer wizard while it is open: what it starts from, what the person chose, the
 * file and its columns for an import, and the run with its progress and outcome.
 */
export class TransferDraft {
  readonly model: WritableSignal<TransferModel>;
  readonly fields: FieldTree<TransferModel>;
  readonly phase = signal<'setup' | 'running' | 'done'>('setup');
  /** Import: the file chosen, a preview of its first rows and its columns. */
  readonly file = signal<TransferSource | undefined>(undefined);
  readonly preview = signal<readonly (readonly unknown[])[]>([]);
  readonly columns = signal<FileColumn[]>([]);
  /** The columns of the table imported into, or of what is copied. */
  readonly tableColumns = signal<readonly ResultColumn[]>([]);
  /** The `CREATE TABLE` a copy or a new table runs first, and what became text. */
  readonly ddl = signal<{ sql: string; text: string[] } | undefined>(undefined);
  readonly key = signal<ReadonlySet<string>>(new Set());
  readonly progress = signal({ rows: 0, bytes: 0, total: 0 });
  readonly outcome = signal<TransferOutcome | undefined>(undefined);
  readonly exported = signal<{ rows: number; cancelled: boolean } | undefined>(undefined);
  readonly error = signal('');
  readonly run: TransferRun;
  /** Other connections a copy can go to. */
  readonly targets = computed(() => this.section.connections());
  /** The target table's name, as the target writes it, for emptying it. */
  readonly clearReady = computed(() => {
    const model = this.model();
    return !model.clear || model.clearName.trim() === model.table.trim();
  });
  /** Writing columns: those of the file that go somewhere, or what is copied. */
  readonly keyChoices = computed(() =>
    this.request.kind === 'import'
      ? this.columns()
          .filter((column) => column.target)
          .map((column) => column.target)
      : this.tableColumns().map((column) => column.name),
  );

  constructor(
    readonly section: DbSection,
    readonly request: TransferRequest,
    readonly files: TransferFilesPort,
    injector: Injector,
  ) {
    this.model = signal(transferModel(request));
    this.fields = form(this.model, { injector });
    this.run = new TransferRun(this);
  }

  workspace() {
    return this.section.state.workspaceId();
  }
  driverOf(connection: string) {
    return readDbConnection(this.section.connection(connection)?.value).driver;
  }
  /** The target table as its engine names it, for `DELETE FROM`. */
  qualified(connection: string, table: string, schema?: string) {
    const style = this.section.quoteStyle(connection);
    return [schema, table]
      .filter(Boolean)
      .map((part) => quoteName(part!, style))
      .join('.');
  }
  exportName() {
    const format = this.model().format;
    return {
      name: this.request.name,
      extension: FILE_EXTENSIONS[format],
      type: FILE_TYPES[format],
    };
  }

  toggleKey(column: string) {
    this.key.update((all) => {
      const next = new Set(all);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }
  setColumn(at: number, change: Partial<FileColumn>) {
    this.columns.update((all) =>
      all.map((column, i) => (i === at ? { ...column, ...change } : column)),
    );
  }
}
