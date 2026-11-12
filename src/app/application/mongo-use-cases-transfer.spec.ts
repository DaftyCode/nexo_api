import { MongoUseCases } from './mongo-use-cases';
import type { ExportSource, TransferEnd } from './mongo-use-cases';
import { WorkspaceDocument } from '../domain/models';
import { documentFields } from '../domain/mongo-transfer';
import { collectionApi, sourceFile, targetFile } from '../testing/mongo-transfer';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://db.test' },
};
const end: TransferEnd = {
  workspace: 'local',
  connection,
  scopes: { environment: [], collection: [], globals: [] },
  target: { database: 'shop', collection: 'orders' },
};
const source: ExportSource = { ...end, query: {} };

/** Documents with the types a round trip must keep. */
const documents = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    _id: { $oid: n.toString(16).padStart(24, '0') },
    n: { $numberInt: String(n) },
    big: { $numberLong: '9007199254740993' },
    price: { $numberDouble: '1.0' },
    at: { $date: { $numberLong: String(1_700_000_000_000 + n) } },
    address: { city: n % 2 ? 'Lugo' : 'Vigo, "centro"' },
    tags: ['a', { $numberInt: '1' }],
  }));

describe('MongoUseCases transfers', { timeout: 60_000 }, () => {
  it('export 100 000 documents and import them back with every type and count', async () => {
    const original = documents(100_000);
    const from = collectionApi(original);
    const file = targetFile();
    const read: number[] = [];
    const exported = await new MongoUseCases(from.api, () => 'id').transfer.export(
      source,
      { format: 'json', flavour: 'canonical', fields: [] },
      file,
      (count) => read.push(count),
      new AbortController().signal,
    );
    expect(exported.documents).toBe(100_000);
    expect(read.at(-1)).toBe(100_000);
    expect(file.state).toBe('closed');
    expect(from.store.open.size).toBe(0);

    const to = collectionApi();
    const imported = await new MongoUseCases(to.api, () => 'id').transfer.import(
      end,
      { format: 'json', columns: [], mode: 'insert', key: [], continueOnError: true },
      sourceFile('orders.json', file.text),
      () => undefined,
      new AbortController().signal,
    );
    expect({
      documents: imported.documents,
      inserted: imported.inserted,
      failed: imported.failed,
    }).toEqual({ documents: 100_000, inserted: 100_000, failed: 0 });
    expect(to.store.documents).toEqual(original);
    expect(Math.max(...to.store.imports.map((p) => (p['documents'] as unknown[]).length))).toBe(
      1000,
    );
  });

  it('export CSV with flattened fields and import it back with its columns typed', async () => {
    const original = documents(3);
    const from = collectionApi(original);
    const mongo = new MongoUseCases(from.api, () => 'id');
    const fields = await mongo.transfer.fields(source);
    expect(fields).toEqual(documentFields(original));
    const file = targetFile();
    await mongo.transfer.export(
      source,
      { format: 'csv', flavour: 'canonical', fields: ['_id', 'n', 'address.city', 'at'] },
      file,
      () => undefined,
      new AbortController().signal,
    );
    expect(file.text.split('\n')[0]).toBe('_id,n,address.city,at');
    expect(file.text).toContain('"Vigo, ""centro"""');

    const to = collectionApi();
    await new MongoUseCases(to.api, () => 'id').transfer.import(
      end,
      {
        format: 'csv',
        columns: [
          { column: '_id', field: '_id', type: 'objectId' },
          { column: 'n', field: 'n', type: 'int' },
          { column: 'address.city', field: 'address.city', type: 'string' },
          { column: 'at', field: 'at', type: 'date' },
        ],
        mode: 'insert',
        key: [],
        continueOnError: true,
      },
      sourceFile('orders.csv', file.text),
      () => undefined,
      new AbortController().signal,
    );
    expect(to.store.documents).toEqual(
      original.map(({ _id, n, at, address }) => ({ _id, n, address, at })),
    );
  });

  it('report failures by position, stop at the first one when asked, and empty only once', async () => {
    const text = '{"a":1}\n{"fail":true}\nnot json\n{"a":4}\n';
    const plan = { format: 'json' as const, columns: [], mode: 'insert' as const, key: [] };
    const run = async (continueOnError: boolean, replace = false) => {
      const to = collectionApi([{ old: true }]);
      const outcome = await new MongoUseCases(to.api, () => 'id').transfer.import(
        end,
        {
          ...plan,
          continueOnError,
          ...(replace ? { mode: 'replace' as const, clearConfirm: 'orders' } : {}),
        },
        sourceFile('a.jsonl', text),
        () => undefined,
        new AbortController().signal,
      );
      return { outcome, store: to.store };
    };
    const going = await run(true);
    expect(going.outcome.failures.map((f) => [f.position, f.key])).toEqual([
      [2, 'mongo.transfer.writeFailed'],
      [3, 'mongo.transfer.badJson'],
    ]);
    expect(going.store.documents).toEqual([{ old: true }, { a: 1 }, { a: 4 }]);

    const stopping = await run(false);
    expect(stopping.outcome.failures.map((f) => f.position)).toEqual([2]);
    expect(stopping.store.documents).toEqual([{ old: true }, { a: 1 }]);
    expect(stopping.store.imports.every((p) => p['ordered'] === true)).toBe(true);

    const replacing = await run(true, true);
    expect(replacing.outcome.cleared).toBe(1);
    expect(replacing.store.imports.filter((p) => 'clearConfirm' in p)).toHaveLength(1);
    expect(replacing.store.documents).toEqual([{ a: 1 }, { a: 4 }]);
  });

  it('cancel an export without leaving a file, and copy a collection to another', async () => {
    const from = collectionApi(documents(2500));
    const mongo = new MongoUseCases(from.api, () => 'id');
    const file = targetFile();
    const stop = new AbortController();
    const outcome = await mongo.transfer.export(
      source,
      { format: 'jsonl', flavour: 'relaxed', fields: [] },
      file,
      () => stop.abort(),
      stop.signal,
    );
    expect(outcome).toEqual(expect.objectContaining({ cancelled: true, documents: 1000 }));
    expect(file.state).toBe('discarded');
    expect(from.store.open.size).toBe(0);

    // The same engine reads the source and writes the copy, of this connection or another.
    const copied = await mongo.transfer.copy(
      source,
      { ...end, target: { database: 'shop', collection: 'copy' } },
      { mode: 'insert', key: [], continueOnError: true },
      () => undefined,
      new AbortController().signal,
    );
    expect(copied.documents).toBe(2500);
    expect(from.store.imports.map((p) => p['collection'])).toEqual(['copy', 'copy', 'copy']);
  });
});
