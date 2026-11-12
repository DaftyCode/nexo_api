import { WorkspaceDocument } from '../../domain/models';
import { VariableScopes } from '../../domain/variables';
import { MongoPorts, QueryTarget, WriteAnswer, WriteWhere, where, writer } from './payload';

/**
 * Writes on a saved connection: documents, collections and databases. The backend refuses
 * them on a read-only connection and records each write of documents to undo it.
 */
export class MongoWriteCases {
  constructor(private readonly api: MongoPorts) {}

  insert(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: WriteWhere,
    documents: Record<string, unknown>[],
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.insert', {
      ...writer(workspace, connection, scopes),
      ...where(target),
      documents,
    });
  }

  /** Updates one document, or with `expected` (the count the person confirmed) many. */
  update(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: WriteWhere,
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    expected?: number,
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.update', {
      ...writer(workspace, connection, scopes),
      ...where(target),
      filter,
      update,
      ...(expected === undefined ? {} : { many: true, expected }),
    });
  }

  replace(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: WriteWhere,
    filter: Record<string, unknown>,
    replacement: Record<string, unknown>,
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.replace', {
      ...writer(workspace, connection, scopes),
      ...where(target),
      filter,
      replacement,
    });
  }

  /** Deletes one document, or with `expected` many; every document also needs `confirm`. */
  deleteDocuments(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: WriteWhere,
    filter: Record<string, unknown>,
    many?: { expected: number; confirm?: string },
  ): Promise<WriteAnswer> {
    return this.api.execute<WriteAnswer>('mongo.delete', {
      ...writer(workspace, connection, scopes),
      ...where(target),
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
      ...writer(workspace, connection, scopes),
      change,
    });
  }

  /** The record of a write, which the backend saved in the workspace. */
  change(id: string): Promise<WorkspaceDocument> {
    return this.api.document(id);
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
      ...writer(workspace, connection, scopes),
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
      ...writer(workspace, connection, scopes),
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
      ...writer(workspace, connection, scopes),
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
      ...writer(workspace, connection, scopes),
      database,
      confirm,
    });
  }
}
