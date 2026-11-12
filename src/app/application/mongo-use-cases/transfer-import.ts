import { CsvReader, JsonDocumentsReader, formatOf, rowDocument } from '../../domain/mongo-transfer';
import { TransferSource } from '../ports';
import { MongoPorts } from './payload';
import { exportPages, importTarget } from './transfer-export';
import {
  ExportSource,
  FILE_CHUNK,
  FileImport,
  ImportPlan,
  TRANSFER_BATCH,
  TransferEnd,
  TransferFailure,
  TransferOutcome,
  TransferProgress,
  emptyOutcome,
  fail,
} from './transfer-types';

/** A document read from the source, or why the one at its position could not be read. */
export type SourceItem =
  | { position: number; document: Record<string, unknown> }
  | { position: number; failure: TransferFailure };

/** What `mongo.import` answers for a batch. */
interface ImportAnswer {
  inserted: number;
  upserted: number;
  replaced: number;
  cleared: number;
  failed: { index: number; message: string }[];
}

/**
 * Writes documents to a collection in batches. `replace` empties it with the first batch;
 * without `continueOnError` the import stops at the first failure.
 */
export async function importDocuments(
  api: MongoPorts,
  end: TransferEnd,
  plan: ImportPlan,
  items: AsyncIterable<SourceItem>,
  progress: (documents: number) => void,
  signal: AbortSignal,
): Promise<TransferOutcome> {
  const outcome = emptyOutcome();
  let batch: { position: number; document: Record<string, unknown> }[] = [];
  let first = true;
  const send = async () => {
    const answer = await api.execute<ImportAnswer>('mongo.import', {
      ...importTarget(end),
      documents: batch.map((item) => item.document),
      mode: plan.mode === 'upsert' ? 'upsert' : 'insert',
      ...(plan.mode === 'upsert' ? { key: [...plan.key] } : {}),
      ...(first && plan.mode === 'replace' ? { clearConfirm: plan.clearConfirm ?? '' } : {}),
      ordered: !plan.continueOnError,
    });
    first = false;
    outcome.inserted += answer.inserted;
    outcome.upserted += answer.upserted;
    outcome.replaced += answer.replaced;
    outcome.cleared += answer.cleared;
    for (const failed of answer.failed)
      fail(outcome, {
        position: batch[failed.index]?.position ?? 0,
        key: 'mongo.transfer.writeFailed',
        params: { v0: failed.message },
      });
    batch = [];
  };
  const stopped = () => signal.aborted || (!plan.continueOnError && outcome.failed > 0);
  for await (const item of items) {
    outcome.documents = item.position;
    if ('failure' in item) fail(outcome, item.failure);
    else batch.push(item);
    if (stopped()) break;
    if (batch.length >= TRANSFER_BATCH) {
      await send();
      progress(outcome.documents);
      if (stopped()) break;
    }
  }
  // What was read before a failure is written, as an ordered batch writes what precedes its
  // first failure; an empty `replace` still empties the collection, unless it failed.
  if (!signal.aborted && (batch.length || (first && !outcome.failed))) await send();
  // Failures to read are found before those of the batch that holds them.
  outcome.failures.sort((a, b) => a.position - b.position);
  if (!plan.continueOnError && outcome.failed) {
    // The import stopped at the first failure in the order of the source; what was read
    // ahead of it does not count.
    outcome.failures = outcome.failures.slice(0, 1);
    outcome.failed = 1;
  }
  outcome.cancelled = signal.aborted;
  progress(outcome.documents);
  return outcome;
}

/**
 * The documents of a file read in chunks: a JSON array, JSON Lines or documents in a row,
 * or a CSV whose first row names the columns.
 */
export async function* fileDocuments(
  file: TransferSource,
  plan: FileImport,
  progress: (progress: TransferProgress) => void,
  signal: AbortSignal,
): AsyncGenerator<SourceItem> {
  const decoder = new TextDecoder('utf-8');
  const json = plan.format === 'csv' ? undefined : new JsonDocumentsReader();
  const csv = plan.format === 'csv' ? new CsvReader() : undefined;
  let position = 0;
  let header = true;
  const items = (text: string, last: boolean): SourceItem[] => {
    if (json) {
      const read = [...json.push(text), ...(last ? json.end() : [])];
      return read.map((item) =>
        'document' in item
          ? { position: ++position, document: item.document }
          : { position: ++position, failure: { position, key: 'mongo.transfer.badJson' } },
      );
    }
    const rows = [...csv!.push(text), ...(last ? csv!.end() : [])];
    if (header && rows.length) {
      rows.shift();
      header = false;
    }
    return rows.map((row) => {
      const { document, errors } = rowDocument(row, plan.columns);
      position++;
      return errors.length
        ? {
            position,
            failure: {
              position,
              key: 'mongo.transfer.badCell',
              params: { v0: errors[0].column, v1: errors[0].type },
            },
          }
        : { position, document };
    });
  };
  try {
    for (let offset = 0; offset < file.size && !signal.aborted;) {
      const bytes = await file.read(offset, FILE_CHUNK);
      if (!bytes.length) break;
      offset += bytes.length;
      // A byte order mark at the start is left out by the decoder.
      const text = decoder.decode(bytes, { stream: true });
      progress({ documents: position, bytes: offset, total: file.size });
      yield* items(text, false);
    }
    if (!signal.aborted) yield* items(decoder.decode(), true);
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** The first documents of a file, and its CSV header, to preview it before importing. */
export async function previewFile(
  file: TransferSource,
  shown = 5,
): Promise<{
  format: FileImport['format'];
  header: string[];
  rows: string[][];
  documents: Record<string, unknown>[];
}> {
  const bytes = await file.read(0, Math.min(file.size, 256 * 1024));
  const text = new TextDecoder('utf-8').decode(bytes);
  const format = formatOf(file.name, text.trimStart()[0] ?? '');
  if (format === 'csv') {
    const [header = [], ...rows] = new CsvReader().push(text);
    return { format, header, rows: rows.slice(0, shown), documents: [] };
  }
  const documents = new JsonDocumentsReader()
    .push(text)
    .flatMap((item) => ('document' in item ? [item.document] : []))
    .slice(0, shown);
  return { format, header: [], rows: [], documents };
}

/** The documents of an export source, to copy them to another collection. */
export async function* copiedDocuments(
  api: MongoPorts,
  source: ExportSource,
  signal: AbortSignal,
): AsyncGenerator<SourceItem> {
  let position = 0;
  for await (const page of exportPages(api, source, () => signal.aborted))
    for (const document of page) yield { position: ++position, document };
}
