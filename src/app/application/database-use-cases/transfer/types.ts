/** What the transfers of data share: their jobs, their outcome and its limits. */
import { ResultColumn } from '../../../domain/db/results';
import { ExportFormat, ExportOptions, ExportShape } from '../../../domain/db/transfer/export';
import { CellTransform, FileColumn } from '../../../domain/db/transfer/import';

/** Rows read at a time from a cursor, and sent in one batch. */
export const TRANSFER_ROWS = 1000;
/** Bytes of a file read at once. */
export const FILE_CHUNK = 1024 * 1024;
/** Failures kept to show; the others are only counted. */
export const FAILURES_KEPT = 100;

export interface ExportJob {
  workspace: string;
  session: string;
  sql: string;
  format: ExportFormat;
  options: ExportOptions;
  /** The table and dialect the rows are named with (SQL `INSERT`s). */
  shape: Omit<ExportShape, 'columns' | 'ddl'>;
  /** SQL: the `CREATE TABLE` of the columns read, written first. */
  ddlFor?: (columns: ResultColumn[]) => Promise<string | undefined>;
}

/** Where rows go: a table of a session, and how they are written. */
export interface WriteTarget {
  workspace: string;
  session: string;
  table: string;
  schema?: string;
  mode: 'insert' | 'upsert';
  key: readonly string[];
  /** Stop at the first failure: the whole transfer is one transaction, undone then. */
  stopOnError: boolean;
  /** Empty the table first (its name was typed). */
  clear: boolean;
  /** A `CREATE TABLE` run first. */
  create?: string;
  confirm?: boolean;
}

export interface ImportJob extends WriteTarget {
  format: 'csv' | 'json';
  separator: string;
  header: boolean;
  columns: readonly FileColumn[];
  transform: CellTransform;
}

export interface CopyJob extends WriteTarget {
  source: string;
  sql: string;
  columns?: readonly string[];
}

export interface TransferFailure {
  position: number;
  last?: number;
  message: string;
}

export interface TransferOutcome {
  read: number;
  inserted: number;
  upserted: number;
  failed: number;
  failures: TransferFailure[];
  /** Stopped at a failure: nothing was left written. */
  stopped: boolean;
  cancelled: boolean;
}

export interface Written {
  inserted: number;
  upserted: number;
  failed: number;
  failures: TransferFailure[];
  stopped?: boolean;
}

export const emptyOutcome = (): TransferOutcome => ({
  read: 0,
  inserted: 0,
  upserted: 0,
  failed: 0,
  failures: [],
  stopped: false,
  cancelled: false,
});

export function add(outcome: TransferOutcome, written: Written) {
  outcome.inserted += written.inserted;
  outcome.upserted += written.upserted;
  outcome.failed += written.failed;
  outcome.failures.push(...written.failures.slice(0, FAILURES_KEPT - outcome.failures.length));
  outcome.stopped ||= !!written.stopped;
}
