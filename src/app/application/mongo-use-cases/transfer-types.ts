import { WorkspaceDocument } from '../../domain/models';
import { BuiltQuery } from '../../domain/mongo-query';
import { CsvColumn, ImportMode, JsonFlavour, TransferFormat } from '../../domain/mongo-transfer';
import { VariableScopes } from '../../domain/variables';
import { QueryTarget } from './payload';

/** Documents in a page read for an export, and in a batch sent by an import. */
export const TRANSFER_BATCH = 1000;
/** Bytes of a file read at once. */
export const FILE_CHUNK = 1024 * 1024;
/** Failures kept to show; the others are only counted. */
export const FAILURES_KEPT = 100;

/** Where a transfer reads or writes documents: a collection of a saved connection. */
export interface TransferEnd {
  workspace: string;
  connection: WorkspaceDocument;
  scopes: VariableScopes;
  target: QueryTarget;
}

/** What an export reads: a query of the collection, or the documents of the page shown. */
export interface ExportSource extends TransferEnd {
  query: BuiltQuery;
  page?: readonly Record<string, unknown>[];
}

export interface ExportFormat {
  format: TransferFormat;
  flavour: JsonFlavour;
  /** CSV: the fields written, in their order. */
  fields: readonly string[];
}

/** How an import writes: the mode, its key fields and whether it goes on after failures. */
export interface ImportPlan {
  mode: ImportMode;
  key: readonly string[];
  continueOnError: boolean;
  /** The collection's name, repeated to empty it first (`replace`). */
  clearConfirm?: string;
}

export interface FileImport extends ImportPlan {
  format: TransferFormat;
  /** CSV: the columns of the header and how each one is written. */
  columns: readonly CsvColumn[];
}

/** A document that was not written, by its position in the source (1 for the first). */
export interface TransferFailure {
  position: number;
  /** A message key, with its values. */
  key: string;
  params?: Record<string, unknown>;
}

export interface TransferProgress {
  /** Documents read so far. */
  documents: number;
  /** Bytes of the file read so far, and its size. */
  bytes: number;
  total: number;
}

export interface TransferOutcome {
  documents: number;
  inserted: number;
  upserted: number;
  replaced: number;
  cleared: number;
  failures: TransferFailure[];
  failed: number;
  cancelled: boolean;
}

export const emptyOutcome = (): TransferOutcome => ({
  documents: 0,
  inserted: 0,
  upserted: 0,
  replaced: 0,
  cleared: 0,
  failures: [],
  failed: 0,
  cancelled: false,
});

/** Adds a failure, keeping only the first ones. */
export function fail(outcome: TransferOutcome, failure: TransferFailure) {
  outcome.failed++;
  if (outcome.failures.length < FAILURES_KEPT) outcome.failures.push(failure);
}
