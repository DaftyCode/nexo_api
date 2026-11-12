import { WorkspaceDocument } from '../../domain/models';
import {
  BuiltAggregationOptions,
  MongoAggregationValue,
  PipelineDocument,
} from '../../domain/mongo-aggregation';
import { DocumentPage } from '../../domain/mongo-query';
import { VariableScopes } from '../../domain/variables';
import { MongoPorts, QueryTarget, savedConnection, writer } from './payload';

/** What an aggregation that writes did: the collection written and how long it took. */
export interface AggregateWritten {
  database: string;
  collection: string;
  elapsedMs: number;
}

/** A pipeline ready to send, with its options. */
export interface BuiltAggregation {
  pipeline: PipelineDocument[];
  options: BuiltAggregationOptions;
}

/** Aggregation pipelines: those that read, those that write, and the saved ones. */
export class MongoAggregationCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly id: () => string,
  ) {}

  /** The first page of an aggregation that reads; `mongo.more` reads the next ones. */
  aggregate(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    aggregation: BuiltAggregation,
    id: string,
    pageSize: number,
  ): Promise<DocumentPage> {
    return this.api.execute<DocumentPage>('mongo.aggregate', {
      workspace,
      connection: savedConnection(connection, scopes),
      database: target.database,
      collection: target.collection,
      pipeline: aggregation.pipeline,
      ...aggregation.options,
      id,
      pageSize,
    });
  }

  /**
   * Runs an aggregation whose last stage, `$out` or `$merge`, writes; `confirm` repeats the
   * name of the collection written. The backend refuses it on a read-only connection.
   */
  write(
    workspace: string,
    connection: WorkspaceDocument,
    scopes: VariableScopes,
    target: QueryTarget,
    aggregation: BuiltAggregation,
    confirm: string,
    id: string,
  ): Promise<AggregateWritten> {
    return this.api.execute<AggregateWritten>('mongo.aggregate.write', {
      ...writer(workspace, connection, scopes),
      database: target.database,
      collection: target.collection,
      pipeline: aggregation.pipeline,
      ...aggregation.options,
      confirm,
      id,
    });
  }

  /** Saves an aggregation in the workspace, as queries are saved. */
  save(
    workspace: string,
    name: string,
    value: MongoAggregationValue,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    return this.api.save({
      id: existing?.id ?? this.id(),
      workspace_id: workspace,
      kind: 'mongo-aggregation',
      name: name.trim() || `${value.database}.${value.collection}`,
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value,
    });
  }

  remove(document: WorkspaceDocument): Promise<void> {
    return this.api.remove(document);
  }
}
