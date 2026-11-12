import { WorkspaceDocument } from '../../domain/models';
import { SchemaReport } from '../../domain/mongo-schema';
import { VariableScopes } from '../../domain/variables';
import { MongoPorts, QueryTarget, savedConnection, writer } from './payload';

/** Which writes a validator checks, and what happens to those it refuses. */
export type ValidationLevel = 'off' | 'strict' | 'moderate';
export type ValidationAction = 'error' | 'warn';

/** The schema explorer: a sample's schema, and validation rules for the collection. */
export class MongoSchemaCases {
  constructor(private readonly api: MongoPorts) {}

  /** The schema of `size` random documents, of the collection or of a filter's documents. */
  sample(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    size: number,
    filter: Record<string, unknown> | undefined,
    id: string,
  ): Promise<SchemaReport> {
    return this.api.execute<SchemaReport>('mongo.schema', {
      workspace,
      connection: savedConnection(connection, scopes),
      database: target.database,
      collection: target.collection,
      size,
      ...(filter && Object.keys(filter).length ? { filter } : {}),
      id,
    });
  }

  /**
   * Replaces the validation rules of a collection; an empty validator removes them.
   * `confirm` repeats its name. The backend refuses it on a read-only connection.
   */
  async validate(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    validator: Record<string, unknown>,
    level: ValidationLevel,
    action: ValidationAction,
    confirm: string,
  ): Promise<void> {
    await this.api.execute('mongo.collection.validator', {
      ...writer(workspace, connection, scopes),
      database: target.database,
      collection: target.collection,
      validator,
      validationLevel: level,
      validationAction: action,
      confirm,
    });
  }
}
