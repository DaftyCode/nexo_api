import { WorkspaceDocument } from '../../domain/models';
import { VariableScopes } from '../../domain/variables';
import { MongoPorts, QueryTarget, savedConnection, writer } from './payload';

/** How a document stands against the other side. */
export type DifferenceKind = 'onlySource' | 'onlyTarget' | 'different';

export interface FieldDifference {
  path: string;
  source?: unknown;
  target?: unknown;
}

export interface CompareResult {
  counts: {
    onlySource: number;
    onlyTarget: number;
    different: number;
    equal: number;
    withoutKey: number;
  };
  differences: { kind: DifferenceKind; key: unknown; fields?: FieldDifference[] }[];
  truncated: boolean;
  key: string;
  elapsedMs: number;
}

export interface SyncResult {
  inserted: number;
  replaced: number;
  deleted: number;
  failed: { index: number; message: string }[];
  elapsedMs: number;
}

/** One side of a comparison: a saved connection and a collection of it. */
export interface CompareSide extends QueryTarget {
  connection: WorkspaceDocument;
}

/** What a comparison reads and leaves out. */
export interface CompareRules {
  filter?: Record<string, unknown>;
  key?: string;
  ignore?: string[];
}

const side = (side: CompareSide, scopes: VariableScopes) => ({
  connection: savedConnection(side.connection, scopes),
  database: side.database,
  collection: side.collection,
});

/** Comparing two collections, and making the target like the source. */
export class MongoCompareCases {
  constructor(private readonly api: MongoPorts) {}

  compare(
    workspace: string,
    scopes: VariableScopes,
    source: CompareSide,
    target: CompareSide,
    rules: CompareRules,
    id: string,
  ): Promise<CompareResult> {
    return this.api.execute<CompareResult>('mongo.compare', {
      workspace,
      id,
      source: side(source, scopes),
      target: side(target, scopes),
      ...rules,
      kept: 1000,
    });
  }

  /**
   * Inserts what the target lacks, replaces what differs and, with `remove`, deletes what
   * only the target has; `confirm` repeats the target collection's name.
   */
  sync(
    workspace: string,
    scopes: VariableScopes,
    source: CompareSide,
    target: CompareSide,
    rules: CompareRules,
    remove: boolean,
    confirm: string,
    id: string,
  ): Promise<SyncResult> {
    return this.api.execute<SyncResult>('mongo.sync', {
      ...writer(workspace, target.connection, scopes),
      database: target.database,
      collection: target.collection,
      id,
      source: side(source, scopes),
      ...rules,
      remove,
      confirm,
    });
  }

  /** Saves a comparison in the workspace, to run it again. */
  save(
    workspace: string,
    name: string,
    value: unknown,
    existing: WorkspaceDocument | undefined,
    id: string,
  ) {
    return this.api.save({
      id: existing?.id ?? id,
      workspace_id: workspace,
      kind: 'mongo-compare',
      name,
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value,
    });
  }
  remove(document: WorkspaceDocument): Promise<void> {
    return this.api.remove(document);
  }
}
