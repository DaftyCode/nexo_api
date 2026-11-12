import { WorkspaceDocument } from '../../domain/models';
import { CollectionStats, CollectionSummary, DatabaseSummary } from '../../domain/mongo-query';
import {
  ConnectionReport,
  ImportedConnection,
  MongoConnectionValue,
  connectionValue,
  isVaultReference,
  parseCompassExport,
} from '../../domain/mongo';
import { VariableScopes } from '../../domain/variables';
import {
  MongoPorts,
  QueryTarget,
  TypedSecrets,
  connectionPayload,
  keySecret,
  passwordSecret,
  savedConnection,
} from './payload';

/** MongoDB connections: kept as workspace documents, their secrets in the vault. */
export class MongoConnectionCases {
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
      connection: savedConnection(connection, scopes),
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
      { workspace, connection: savedConnection(connection, scopes), database },
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
      connection: savedConnection(connection, scopes),
      database: target.database,
      collection: target.collection,
    });
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
