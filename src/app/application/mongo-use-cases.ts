import { DocumentRepositoryPort, ExecutionPort, SecretVaultPort } from './ports';
import type { MongoConnection } from './payloads';
import { WorkspaceDocument } from '../domain/models';
import {
  BuiltQuery,
  CollectionStats,
  CollectionSummary,
  DatabaseSummary,
  DocumentPage,
  MongoQueryValue,
  queryValue,
  querySummary,
} from '../domain/mongo-query';
import {
  ConnectionReport,
  ImportedConnection,
  MongoConnectionValue,
  connectionValue,
  isVaultReference,
  parseCompassExport,
} from '../domain/mongo';
import { VariableScopes, resolveVariables } from '../domain/variables';

export { resolveVariables };

type MongoPorts = ExecutionPort &
  Pick<DocumentRepositoryPort, 'save' | 'remove' | 'document'> &
  Pick<SecretVaultPort, 'putSecret' | 'removeSecret'>;

/** Secrets typed in the form, not saved yet. Blank keeps what is stored. */
export interface TypedSecrets {
  password?: string;
  keyPem?: string;
}

/** The vault entries Nexo creates for a connection. */
export const passwordSecret = (id: string) => `mongo-password:${id}`;
export const keySecret = (id: string) => `mongo-key:${id}`;

/** What a write did; `change` names the record that undoes it. */
export interface WriteAnswer {
  matched: number;
  modified: number;
  deleted: number;
  inserted: unknown[];
  change: string;
}

/** Where a write goes, and its write concern when it is not the connection's. */
export interface WriteWhere extends QueryTarget {
  writeConcern?: Record<string, unknown>;
}

/** Where a query runs. */
export interface QueryTarget {
  database: string;
  collection: string;
}

/**
 * A connection as the backend receives it: variables of the active environment replaced,
 * vault references kept for the backend, and secrets typed but not saved yet used as typed.
 */
export function connectionPayload(
  value: MongoConnectionValue,
  scopes: VariableScopes,
  typed: TypedSecrets = {},
): MongoConnection {
  const resolve = (text: string | undefined) =>
    text?.trim() ? resolveVariables(text, scopes) : undefined;
  const connection: MongoConnection = {
    uri: resolve(value.uri) ?? '',
    password: typed.password || value.password,
    caPem: resolve(value.caPem),
    certPem: resolve(value.certPem),
    keyPem: typed.keyPem?.trim() || value.keyPem,
  };
  for (const key of Object.keys(connection) as (keyof MongoConnection)[])
    if (connection[key] === undefined) delete connection[key];
  return connection;
}

/** MongoDB connections: kept as workspace documents, their secrets in the vault. */
export class MongoUseCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly id: () => string,
  ) {}

  /**
   * Saves a connection. A password or key typed in the form goes to the vault, under a name
   * of this connection, and the document keeps only its reference.
   */
  async save(
    workspace: string,
    name: string,
    value: MongoConnectionValue,
    typed: TypedSecrets,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const id = existing?.id ?? this.id();
    const stored: MongoConnectionValue = { ...value };
    const password = typed.password ?? '';
    if (password) {
      if (isVaultReference(password)) stored.password = password.trim();
      else {
        await this.api.putSecret(passwordSecret(id), password);
        stored.password = `{{vault:${passwordSecret(id)}}}`;
      }
    }
    const key = typed.keyPem?.trim() ?? '';
    if (key) {
      if (isVaultReference(key)) stored.keyPem = key;
      else {
        await this.api.putSecret(keySecret(id), key);
        stored.keyPem = `{{vault:${keySecret(id)}}}`;
      }
    }
    for (const field of ['password', 'caPem', 'certPem', 'keyPem', 'folder', 'color'] as const)
      if (!stored[field]?.trim()) delete stored[field];
    if (!stored.readOnly) delete stored.readOnly;
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'connection',
      name: name.trim() || 'MongoDB',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: stored,
    });
  }

  /** Deletes a connection and the secrets Nexo created for it. */
  async remove(document: WorkspaceDocument) {
    await this.api.remove(document);
    const value = connectionValue(document.value);
    for (const [field, name] of [
      ['password', passwordSecret(document.id)],
      ['keyPem', keySecret(document.id)],
    ] as const) {
      if (value[field]?.includes(name)) await this.api.removeSecret(name).catch(() => undefined);
    }
  }

  /**
   * Tests a connection as the form shows it: variables of the active environment are
   * replaced, and secrets typed but not saved yet are used as they are.
   */
  test(
    workspace: string,
    value: MongoConnectionValue,
    typed: TypedSecrets,
    scopes: VariableScopes,
  ): Promise<ConnectionReport> {
    const connection = connectionPayload(value, scopes, typed);
    return this.api.execute<ConnectionReport>('mongo.test', { workspace, connection });
  }

  /** The databases of a saved connection the user may read. */
  async databases(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
  ): Promise<DatabaseSummary[]> {
    const answer = await this.api.execute<{ databases: DatabaseSummary[] }>('mongo.databases', {
      workspace,
      connection: this.payload(connection, scopes),
    });
    return answer.databases;
  }

  async collections(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
  ): Promise<CollectionSummary[]> {
    const answer = await this.api.execute<{ collections: CollectionSummary[] }>(
      'mongo.collections',
      { workspace, connection: this.payload(connection, scopes), database },
    );
    return answer.collections;
  }

  stats(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
  ): Promise<CollectionStats> {
    return this.api.execute<CollectionStats>('mongo.stats', {
      workspace,
      connection: this.payload(connection, scopes),
      database: target.database,
      collection: target.collection,
    });
  }

  /** The first page of a query; `id` cancels it while it runs. */
  find(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    query: BuiltQuery,
    id: string,
    pageSize: number,
  ): Promise<DocumentPage> {
    return this.api.execute<DocumentPage>('mongo.find', {
      workspace,
      connection: this.payload(connection, scopes),
      database: target.database,
      collection: target.collection,
      ...query,
      id,
      pageSize,
    });
  }

  /** The next page of a query's open cursor. */
  more(workspace: string, cursor: string, id: string, pageSize: number): Promise<DocumentPage> {
    return this.api.execute<DocumentPage>('mongo.more', { workspace, cursor, id, pageSize });
  }

  /** How many documents the query matches: a separate step, as it reads the whole collection. */
  async count(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    query: BuiltQuery,
    id: string,
  ): Promise<number> {
    const { filter, collation, hint, skip, limit } = query;
    const answer = await this.api.execute<{ count: number }>('mongo.count', {
      workspace,
      connection: this.payload(connection, scopes),
      database: target.database,
      collection: target.collection,
      ...(filter ? { filter } : {}),
      ...(collation ? { collation } : {}),
      ...(hint ? { hint } : {}),
      ...(skip ? { skip } : {}),
      ...(limit ? { limit } : {}),
      id,
    });
    return answer.count;
  }

  async cancel(workspace: string, id: string): Promise<boolean> {
    const answer = await this.api.execute<{ cancelled: boolean }>('mongo.cancel', {
      workspace,
      id,
    });
    return answer.cancelled;
  }

  /** Closes the cursor of results nobody reads any more. Failures do not matter. */
  async close(workspace: string, cursor: string): Promise<void> {
    await this.api.execute('mongo.close', { workspace, cursor }).catch(() => undefined);
  }

  /** Saves a query in the workspace, as requests are saved in a collection. */
  saveQuery(
    workspace: string,
    name: string,
    value: MongoQueryValue,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const stored: Partial<MongoQueryValue> = { ...value };
    for (const key of Object.keys(stored) as (keyof MongoQueryValue)[])
      if (!stored[key]?.trim() && key !== 'database' && key !== 'collection') delete stored[key];
    return this.api.save({
      id: existing?.id ?? this.id(),
      workspace_id: workspace,
      kind: 'query',
      name: name.trim() || querySummary(value),
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: stored,
    });
  }

  removeQuery(document: WorkspaceDocument): Promise<void> {
    return this.api.remove(document);
  }

  /** Adds a query that ran to the history: only the query, never its results. */
  recordHistory(workspace: string, value: MongoQueryValue): Promise<WorkspaceDocument> {
    return this.api.save({
      id: this.id(),
      workspace_id: workspace,
      kind: 'query-history',
      name: querySummary(value),
      revision: 0,
      updated_at: 0,
      value,
    });
  }

  /** A history entry's query: the listing has only its name. */
  async historyQuery(document: WorkspaceDocument): Promise<MongoQueryValue> {
    return queryValue(document.value ?? (await this.api.document(document.id)).value);
  }

  /** The saved connection a write names: the backend refuses it when it is read-only. */
  private writer(workspace: string, connection: WorkspaceDocument, scopes: VariableScopes) {
    return {
      workspace,
      connection: this.payload(connection, scopes),
      connectionId: connection.id,
    };
  }
  private where({ database, collection, writeConcern }: WriteWhere) {
    return { database, collection, ...(writeConcern ? { writeConcern } : {}) };
  }

  insert(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    where: WriteWhere,
    documents: Record<string, unknown>[],
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.insert', {
      ...this.writer(workspace, connection, scopes),
      ...this.where(where),
      documents,
    });
  }

  /** Updates one document, or with `expected` (the count the person confirmed) many. */
  update(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    where: WriteWhere,
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    expected?: number,
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.update', {
      ...this.writer(workspace, connection, scopes),
      ...this.where(where),
      filter,
      update,
      ...(expected === undefined ? {} : { many: true, expected }),
    });
  }

  replace(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    where: WriteWhere,
    filter: Record<string, unknown>,
    replacement: Record<string, unknown>,
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.replace', {
      ...this.writer(workspace, connection, scopes),
      ...this.where(where),
      filter,
      replacement,
    });
  }

  /** Deletes one document, or with `expected` many; every document also needs `confirm`. */
  deleteDocuments(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    where: WriteWhere,
    filter: Record<string, unknown>,
    many?: { expected: number; confirm?: string },
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.delete', {
      ...this.writer(workspace, connection, scopes),
      ...this.where(where),
      filter,
      ...(many ? { many: true, ...many } : {}),
    });
  }

  undo(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    change: string,
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.undo', {
      ...this.writer(workspace, connection, scopes),
      change,
    });
  }

  /** Creates a collection, and its database when it is new. */
  async createCollection(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    options: Record<string, unknown>,
  ): Promise<void> {
    await this.api.execute('mongo.collection.create', {
      ...this.writer(workspace, connection, scopes),
      ...target,
      ...(Object.keys(options).length ? { options } : {}),
    });
  }

  async renameCollection(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    to: string,
  ): Promise<void> {
    await this.api.execute('mongo.collection.rename', {
      ...this.writer(workspace, connection, scopes),
      ...target,
      to,
    });
  }

  async dropCollection(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    confirm: string,
  ): Promise<void> {
    await this.api.execute('mongo.collection.drop', {
      ...this.writer(workspace, connection, scopes),
      ...target,
      confirm,
    });
  }

  async dropDatabase(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
    confirm: string,
  ): Promise<void> {
    await this.api.execute('mongo.database.drop', {
      ...this.writer(workspace, connection, scopes),
      database,
      confirm,
    });
  }

  /** The record of a write, which the backend saved in the workspace. */
  change(id: string): Promise<WorkspaceDocument> {
    return this.api.document(id);
  }

  private payload(connection: WorkspaceDocument, scopes: VariableScopes): MongoConnection {
    return connectionPayload(connectionValue(connection.value), scopes);
  }

  /** Connections of a MongoDB Compass export, saved with their passwords in the vault. */
  async importCompass(workspace: string, text: string): Promise<WorkspaceDocument[]> {
    const connections: ImportedConnection[] = parseCompassExport(text);
    if (!connections.length) throw new Error('The file has no connections');
    const saved: WorkspaceDocument[] = [];
    for (const connection of connections) {
      saved.push(
        await this.save(
          workspace,
          connection.name,
          { uri: connection.uri, ...(connection.color ? { color: connection.color } : {}) },
          { password: connection.password },
        ),
      );
    }
    return saved;
  }
}
