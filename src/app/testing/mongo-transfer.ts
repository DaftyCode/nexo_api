/** A MongoDB collection in memory and files in memory, for the tests of imports and exports. */
import { TransferFilesPort, TransferSource, TransferTarget } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';

type Doc = Record<string, unknown>;

/** Answers `mongo.find`, `mongo.more`, `mongo.close` and `mongo.import` on a list. */
export function collectionApi(documents: Doc[] = []) {
  const store = { documents: [...documents], imports: [] as Doc[], open: new Set<string>() };
  const pages = new Map<string, Doc[]>();
  let cursors = 0;
  const page = (rest: Doc[], size: number) => {
    const documents = rest.slice(0, size);
    const left = rest.slice(size);
    if (!left.length) return { documents, truncated: false, elapsedMs: 1 };
    const cursor = `c${++cursors}`;
    pages.set(cursor, left);
    store.open.add(cursor);
    return { documents, cursor, truncated: false, elapsedMs: 1 };
  };
  const execute = async (operation: string, payload: Doc) => {
    if (operation === 'mongo.find') {
      const limit = Number(payload['limit'] ?? 0);
      const all = limit ? store.documents.slice(0, limit) : store.documents;
      return page(all, Number(payload['pageSize']));
    }
    if (operation === 'mongo.more') {
      const cursor = String(payload['cursor']);
      store.open.delete(cursor);
      return page(pages.get(cursor) ?? [], Number(payload['pageSize']));
    }
    if (operation === 'mongo.close') {
      store.open.delete(String(payload['cursor']));
      return { closed: true };
    }
    if (operation === 'mongo.import') {
      store.imports.push(payload);
      let cleared = 0;
      if (payload['clearConfirm'] !== undefined) {
        cleared = store.documents.length;
        store.documents = [];
      }
      const failed: { index: number; message: string }[] = [];
      for (const [index, document] of (payload['documents'] as Doc[]).entries()) {
        if (document['fail']) {
          failed.push({ index, message: 'refused' });
          if (payload['ordered']) break;
        } else store.documents.push(document);
      }
      const written = (payload['documents'] as Doc[]).length - failed.length;
      return {
        inserted: payload['ordered'] && failed.length ? failed[0].index : written,
        upserted: 0,
        replaced: 0,
        cleared,
        failed,
      };
    }
    throw new Error(`Unexpected ${operation}`);
  };
  const api = {
    execute,
    save: async (document: WorkspaceDocument) => document,
    remove: async () => undefined,
  };
  return { api: api as never, store };
}

/** A file to import, read from text in chunks of `size` bytes (the last one at most). */
export function sourceFile(name: string, text: string): TransferSource & { closed: boolean } {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.length,
    closed: false,
    read: async (offset, length) => bytes.slice(offset, offset + length),
    async close() {
      this.closed = true;
    },
  };
}

/** A file an export writes, kept as text. */
export function targetFile(): TransferTarget & { text: string; state: string } {
  return {
    name: 'export',
    text: '',
    state: 'open',
    async write(text) {
      this.text += text;
    },
    async close() {
      this.state = 'closed';
    },
    async discard() {
      this.state = 'discarded';
    },
  };
}

/** Files chosen in tests: the next source given, and every export kept. */
export class TestTransferFiles implements TransferFilesPort {
  readonly sources: TransferSource[] = [];
  readonly targets: ReturnType<typeof targetFile>[] = [];
  async open() {
    return this.sources.shift();
  }
  async save(name: string) {
    const target = { ...targetFile(), name };
    this.targets.push(target);
    return target;
  }
}
