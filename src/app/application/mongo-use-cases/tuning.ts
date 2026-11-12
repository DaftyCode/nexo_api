import { WorkspaceDocument } from '../../domain/models';
import { VariableScopes } from '../../domain/variables';
import { IndexDetail, ProfileEntry, ProfileStatus } from '../../domain/mongo-indexes';
import { ExplainedQuery, MongoPorts, QueryTarget, savedConnection, writer } from './payload';

/** What makes queries fast: indexes, how the server runs a query, and the profiler. */
export class MongoTuningCases {
  constructor(private readonly api: MongoPorts) {}

  /** The indexes of a collection, with their size and how often queries used them. */
  async indexes(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
  ): Promise<IndexDetail[]> {
    const answer = await this.api.execute<{ indexes: IndexDetail[] }>('mongo.indexes', {
      workspace,
      connection: savedConnection(connection, scopes),
      ...target,
    });
    return answer.indexes ?? [];
  }

  async createIndex(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    keys: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<void> {
    await this.api.execute('mongo.index.create', {
      ...writer(workspace, connection, scopes),
      ...target,
      keys,
      ...(Object.keys(options).length ? { options } : {}),
    });
  }

  /** Hides an index from the query planner, or shows it again. */
  async hideIndex(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    name: string,
    hidden: boolean,
  ): Promise<void> {
    await this.api.execute('mongo.index.hide', {
      ...writer(workspace, connection, scopes),
      ...target,
      name,
      hidden,
    });
  }

  /** Drops an index; `confirm` repeats its name. */
  async dropIndex(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    name: string,
    confirm: string,
  ): Promise<void> {
    await this.api.execute('mongo.index.drop', {
      ...writer(workspace, connection, scopes),
      ...target,
      name,
      confirm,
    });
  }

  /**
   * How the server runs a query. `executed` runs it to measure it (`executionStats`);
   * otherwise it is only planned. `id` cancels it with `cancel`.
   */
  async explain(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    explained: ExplainedQuery,
    executed: boolean,
    id: string,
  ): Promise<unknown> {
    const answer = await this.api.execute<{ explain: unknown }>('mongo.explain', {
      workspace,
      connection: savedConnection(connection, scopes),
      ...target,
      ...('pipeline' in explained ? explained : explained.query),
      verbosity: executed ? 'executionStats' : 'queryPlanner',
      id,
    });
    return answer.explain;
  }

  /** The profiler level of a database and its threshold. */
  profile(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
  ): Promise<ProfileStatus> {
    return this.api.execute<ProfileStatus>('mongo.profile', {
      workspace,
      connection: savedConnection(connection, scopes),
      database,
    });
  }

  /** Changes the profiler of a database on the server; refused on a read-only connection. */
  setProfile(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
    level: 0 | 1 | 2,
    slowms?: number,
  ): Promise<ProfileStatus> {
    return this.api.execute<ProfileStatus>('mongo.profile.set', {
      ...writer(workspace, connection, scopes),
      database,
      level,
      ...(slowms === undefined ? {} : { slowms }),
    });
  }

  /** The slowest operations the profiler recorded, of a database or of one collection. */
  async profileEntries(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    database: string,
    collection?: string,
  ): Promise<ProfileEntry[]> {
    const answer = await this.api.execute<{ entries: ProfileEntry[] }>('mongo.profile.entries', {
      workspace,
      connection: savedConnection(connection, scopes),
      database,
      ...(collection ? { collection } : {}),
    });
    return answer.entries ?? [];
  }
}
