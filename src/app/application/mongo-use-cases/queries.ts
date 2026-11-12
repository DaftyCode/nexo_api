import { WorkspaceDocument } from '../../domain/models';
import {
  BuiltQuery,
  DocumentPage,
  MongoQueryValue,
  queryValue,
  querySummary,
} from '../../domain/mongo-query';
import { VariableScopes } from '../../domain/variables';
import { MongoPorts, QueryTarget, savedConnection } from './payload';

/** Queries of a collection: pages, counts, cancelling, and the saved queries and history. */
export class MongoQueryCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly id: () => string,
  ) {}

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
      connection: savedConnection(connection, scopes),
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
      connection: savedConnection(connection, scopes),
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

  /** Cancels a query, count or explain that is running. */
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
}
