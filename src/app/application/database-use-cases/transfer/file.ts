import { CsvReader } from '../../../domain/mongo-transfer/csv';
import { JsonDocumentsReader } from '../../../domain/mongo-transfer/json';
import { BOM } from '../../../domain/db/transfer/export';
import { objectRows, rowValues } from '../../../domain/db/transfer/import';
import { TransferSource } from '../../ports';
import { FILE_CHUNK, ImportJob, TRANSFER_ROWS, TransferOutcome, Written, add } from './types';

/**
 * Reads a CSV or JSON file a chunk at a time and sends its rows in batches: the header of a
 * CSV skipped, each row turned into the values of the columns that go somewhere.
 */
export async function readFile(
  job: ImportJob,
  file: TransferSource,
  outcome: TransferOutcome,
  send: (rows: unknown[][], first: number) => Promise<Written>,
  progress: (outcome: TransferOutcome, bytes: number) => void,
  signal: AbortSignal,
) {
  const decoder = new TextDecoder('utf-8');
  const csv = new CsvReader(job.separator);
  const json = new JsonDocumentsReader();
  const keys = job.columns.map((column) => column.name);
  let pending: unknown[][] = [];
  let header = job.format === 'csv' && job.header;
  let offset = 0;
  const flush = async () => {
    if (!pending.length) return;
    const rows = pending.map((row) => rowValues(row, job.columns, job.transform));
    const first = outcome.read - pending.length + 1;
    pending = [];
    add(outcome, await send(rows, first));
  };
  const take = async (rows: unknown[][]) => {
    for (const row of rows) {
      if (header) {
        header = false;
        continue;
      }
      pending.push(row);
      outcome.read++;
      if (pending.length >= TRANSFER_ROWS) await flush();
      if (outcome.stopped || signal.aborted) return;
    }
  };
  while (offset < file.size && !outcome.stopped && !signal.aborted) {
    const bytes = await file.read(offset, FILE_CHUNK);
    if (!bytes.length) break;
    offset += bytes.length;
    let text = decoder.decode(bytes, { stream: true });
    if (offset === bytes.length && text.startsWith(BOM)) text = text.slice(1);
    if (job.format === 'csv') await take(csv.push(text));
    else {
      const read = json.push(text);
      const objects = read.flatMap((each) => ('document' in each ? [each.document] : []));
      await take(objectRows(objects, keys));
    }
    progress(outcome, offset);
  }
  if (!outcome.stopped && !signal.aborted) {
    if (job.format === 'csv') await take(csv.end());
    await flush();
  }
  progress(outcome, offset);
}
