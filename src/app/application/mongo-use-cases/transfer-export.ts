import { readingPipeline } from '../../domain/mongo-aggregation';
import { DocumentPage } from '../../domain/mongo-query';
import { csvRecord, csvRow, documentFields, jsonDocument } from '../../domain/mongo-transfer';
import { TransferTarget } from '../ports';
import { MongoPorts, savedConnection } from './payload';
import {
  ExportFormat,
  ExportSource,
  TRANSFER_BATCH,
  TransferEnd,
  TransferOutcome,
  emptyOutcome,
} from './transfer-types';

/** The first page of the query or the pipeline of an export, `limit` documents at most. */
function firstPage(
  api: MongoPorts,
  source: ExportSource,
  id: string,
  pageSize: number,
  limit?: number,
): Promise<DocumentPage> {
  const { workspace, connection, scopes, target, query, pipeline } = source;
  const where = {
    workspace,
    connection: savedConnection(connection, scopes),
    database: target.database,
    collection: target.collection,
    id,
    pageSize,
  };
  if (pipeline)
    return api.execute<DocumentPage>('mongo.aggregate', {
      ...where,
      ...pipeline.options,
      pipeline: [...readingPipeline(pipeline.pipeline), ...(limit ? [{ $limit: limit }] : [])],
    });
  return api.execute<DocumentPage>('mongo.find', {
    ...where,
    ...query,
    ...(limit ? { limit } : {}),
  });
}

/**
 * The documents of an export, page by page through an open cursor; the page shown is one
 * page. `stop` is asked before each page.
 */
export async function* exportPages(
  api: MongoPorts,
  source: ExportSource,
  stop: () => boolean,
): AsyncGenerator<readonly Record<string, unknown>[]> {
  if (source.page) {
    yield source.page;
    return;
  }
  const { workspace } = source;
  const id = () => `transfer-${crypto.randomUUID()}`;
  let page = await firstPage(api, source, id(), TRANSFER_BATCH);
  try {
    for (;;) {
      if (page.documents.length) yield page.documents;
      if (!page.cursor || stop()) return;
      page = await api.execute<DocumentPage>('mongo.more', {
        workspace,
        cursor: page.cursor,
        id: id(),
        pageSize: TRANSFER_BATCH,
      });
    }
  } finally {
    if (page.cursor)
      await api.execute('mongo.close', { workspace, cursor: page.cursor }).catch(() => undefined);
  }
}

/** The fields of the first documents of a collection or query, for the columns of a CSV. */
export async function sampleFields(api: MongoPorts, source: ExportSource): Promise<string[]> {
  if (source.page) return documentFields(source.page);
  const page = await firstPage(api, source, `fields-${crypto.randomUUID()}`, 100, 100);
  if (page.cursor)
    await api
      .execute('mongo.close', { workspace: source.workspace, cursor: page.cursor })
      .catch(() => undefined);
  return documentFields(page.documents);
}

/**
 * Writes an export to a file: a JSON array, JSON Lines or CSV with a header. A cancelled
 * export leaves no file.
 */
export async function exportToFile(
  api: MongoPorts,
  source: ExportSource,
  format: ExportFormat,
  file: TransferTarget,
  progress: (documents: number) => void,
  signal: AbortSignal,
): Promise<TransferOutcome> {
  const outcome = emptyOutcome();
  try {
    if (format.format === 'csv') await file.write(csvRow(format.fields) + '\n');
    if (format.format === 'json') await file.write('[');
    for await (const page of exportPages(api, source, () => signal.aborted)) {
      const lines = page.map((document) =>
        format.format === 'csv'
          ? csvRecord(document, format.fields)
          : jsonDocument(document, format.flavour),
      );
      const separator = format.format === 'json' ? ',\n' : '\n';
      const lead = format.format === 'json' ? (outcome.documents ? ',\n' : '\n') : '';
      await file.write(lead + lines.join(separator) + (format.format === 'json' ? '' : '\n'));
      outcome.documents += page.length;
      progress(outcome.documents);
      if (signal.aborted) break;
    }
    if (signal.aborted) {
      outcome.cancelled = true;
      await file.discard();
      return outcome;
    }
    if (format.format === 'json') await file.write(outcome.documents ? '\n]\n' : ']\n');
    await file.close();
    return outcome;
  } catch (error) {
    await file.discard().catch(() => undefined);
    throw error;
  }
}

/** The connection and target of `mongo.import`, as every batch of an import sends them. */
export function importTarget(end: TransferEnd) {
  return {
    workspace: end.workspace,
    connection: savedConnection(end.connection, end.scopes),
    connectionId: end.connection.id,
    database: end.target.database,
    collection: end.target.collection,
  };
}
