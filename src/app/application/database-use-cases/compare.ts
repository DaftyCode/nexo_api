import {
  CompareKind,
  CompareWarning,
  DataComparison,
  SchemaComparison,
  readDataComparison,
  readSchemaComparison,
  readWarnings,
  tableOf,
} from '../../domain/db/compare';
import { DbNode } from '../../domain/db/tree';
import { ExecutionPort } from '../ports';

/** A side of a comparison: a session and what it compares (a schema or database, or a table). */
export interface CompareSideRef {
  session: string;
  path: readonly string[];
  table?: boolean;
}

export interface StructureOptions {
  ignoreComments: boolean;
  ignoreColumnOrder: boolean;
  ignoreConstraintNames: boolean;
}

export interface DataOptions {
  key: readonly string[];
  ignore: readonly string[];
  filter: string;
}

/** A schema, database or table of a connection that can be compared, with its label. */
export interface CompareCandidate {
  path: string[];
  label: string;
}

/** Nodes of the tree asked for while looking for what can be compared. */
const LOOKS = 60;
/** Folders the search goes into, besides schemas and databases. */
const LEADS = new Set(['databases', 'schemas', 'tables']);

const table = (side: CompareSideRef) => ({
  session: side.session,
  path: side.path,
  ...tableOf(side.path),
});

/**
 * Comparing two databases (DB-24): their structure, the script that makes the target like
 * the source, their data, and synchronizing it. The backend reads both sides with their own
 * sessions; nothing here runs on them but what the person asks.
 */
export class DatabaseCompareCases {
  constructor(private readonly api: ExecutionPort) {}

  async structure(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: StructureOptions,
  ): Promise<SchemaComparison> {
    const answer = await this.api.execute('db.compare.schema', {
      workspace,
      source,
      target,
      ...options,
    });
    return readSchemaComparison(answer);
  }

  /** The DDL that makes the target like the source; `drop` also drops what only it has. */
  async script(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: StructureOptions,
    drop: boolean,
  ): Promise<{ statements: string[]; warnings: CompareWarning[] }> {
    const answer = await this.api.execute<{ statements?: string[]; warnings?: unknown }>(
      'db.compare.script',
      { workspace, source, target, ...options, drop },
    );
    return { statements: answer.statements ?? [], warnings: readWarnings(answer.warnings) };
  }

  private payload(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: DataOptions,
    statement: string,
  ) {
    return {
      workspace,
      source: table(source),
      target: table(target),
      statement,
      ...(options.key.length ? { key: options.key } : {}),
      ...(options.ignore.length ? { ignore: options.ignore } : {}),
      ...(options.filter.trim() ? { filter: options.filter.trim() } : {}),
    };
  }

  async data(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: DataOptions,
    statement: string,
  ): Promise<DataComparison> {
    const answer = await this.api.execute(
      'db.compare.data',
      this.payload(workspace, source, target, options, statement),
    );
    return readDataComparison(answer);
  }

  /** The `INSERT`, `UPDATE` and `DELETE` that would make the target's rows like the source's. */
  async dataScript(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: DataOptions,
    statement: string,
    remove: boolean,
  ): Promise<string[]> {
    const answer = await this.api.execute<{ statements?: string[] }>('db.sync.data', {
      ...this.payload(workspace, source, target, options, statement),
      script: true,
      delete: remove,
    });
    return answer.statements ?? [];
  }

  /** Makes the target's rows like the source's, in one transaction. */
  sync(
    workspace: string,
    source: CompareSideRef,
    target: CompareSideRef,
    options: DataOptions,
    statement: string,
    confirmed: { remove: boolean; name: string; production: boolean },
  ): Promise<{ inserted: number; updated: number; deleted: number }> {
    return this.api.execute('db.sync.data', {
      ...this.payload(workspace, source, target, options, statement),
      delete: confirmed.remove,
      confirmName: confirmed.name,
      ...(confirmed.production ? { confirm: true } : {}),
    });
  }

  /** Stops the reads of a comparison on both sides. */
  async cancel(workspace: string, sessions: readonly string[], statement: string) {
    for (const session of sessions)
      await this.api.execute('db.cancel', { workspace, session, statement }).catch(() => undefined);
  }

  /** The schemas and databases, or the tables, of a connection that can be compared. */
  async candidates(
    workspace: string,
    session: string,
    kind: CompareKind,
  ): Promise<CompareCandidate[]> {
    const found: CompareCandidate[] = [];
    let looks = 0;
    const walk = async (at: string[], labels: string[], depth: number): Promise<void> => {
      if (looks++ >= LOOKS || depth > 4) return;
      const answer = await this.api.execute<{ nodes: DbNode[] }>('db.tree', {
        workspace,
        session,
        path: at,
      });
      for (const node of answer.nodes ?? []) {
        if (node.system) continue;
        const next = [...at, node.name];
        const shown = [...labels, node.label];
        const wanted =
          kind === 'table' ? node.kind === 'table' : ['schema', 'database'].includes(node.kind);
        if (wanted) found.push({ path: next, label: shown.join(' / ') });
        if (node.kind === 'schema' || node.kind === 'database' || LEADS.has(node.name))
          if (!(kind === 'schema' && node.kind === 'schema'))
            await walk(next, LEADS.has(node.name) ? labels : shown, depth + 1);
      }
    };
    await walk([], [], 0);
    return found;
  }
}
