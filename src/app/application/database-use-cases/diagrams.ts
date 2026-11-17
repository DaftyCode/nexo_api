import {
  DiagramTable,
  DiagramValue,
  diagramTable,
  siblingTable,
} from '../../domain/db/erd-document';
import { ErdTable, entityKey, tableFromDescription, tableFromModel } from '../../domain/db/erd';
import { readTable } from '../../domain/db/structure';
import { DbNode } from '../../domain/db/tree';
import { WorkspaceDocument } from '../../domain/models';
import { DocumentRepositoryPort, ExecutionPort } from '../ports';

/** Tables read for a diagram at once. */
const AT_ONCE = 6;
/** Tree calls made, at most, to find the tables under a node. */
const LOOKS = 60;
/** Folders and kinds of node that lead to tables. */
const LEADS = new Set(['databases', 'schemas', 'tables']);

interface Described {
  sections: { id: string; columns: string[]; rows: unknown[][] }[];
}

/**
 * The entity-relationship diagrams (DB-20): the tables under a node of the tree, their
 * structure read a few at a time (`ddl.model`, or `db.describe` for a driver without it), the
 * tables that reference one, and the diagrams saved by the person.
 */
export class DatabaseDiagramCases {
  constructor(
    private readonly api: ExecutionPort & Pick<DocumentRepositoryPort, 'save' | 'remove'>,
  ) {}

  /** The tables under a node: a schema, a database, a folder of tables, or the root. */
  async tables(
    workspace: string,
    session: string,
    path: readonly string[],
  ): Promise<DiagramTable[]> {
    const found: DiagramTable[] = [];
    let looks = 0;
    const walk = async (at: readonly string[], depth: number): Promise<void> => {
      if (looks++ >= LOOKS || depth > 4) return;
      const answer = await this.api.execute<{ nodes: DbNode[] }>('db.tree', {
        workspace,
        session,
        path: at,
      });
      for (const node of answer.nodes ?? []) {
        if (node.system) continue;
        const next = [...at, node.name];
        if (node.kind === 'table') found.push(diagramTable(next));
        else if (node.kind === 'schema' || node.kind === 'database' || LEADS.has(node.name))
          await walk(next, depth + 1);
      }
    };
    await walk(path, 0);
    return found;
  }

  /**
   * The structure of some tables, read a few at a time; `done` says how many were read. A
   * table that cannot be read (dropped since) is left out, unless none can.
   */
  async read(
    workspace: string,
    session: string,
    tables: readonly DiagramTable[],
    structured: boolean,
    done: (count: number) => void = () => undefined,
  ): Promise<ErdTable[]> {
    const read: ErdTable[] = [];
    let failure: unknown;
    for (let at = 0; at < tables.length; at += AT_ONCE) {
      const batch = await Promise.allSettled(
        tables
          .slice(at, at + AT_ONCE)
          .map((table) => this.one(workspace, session, table, structured)),
      );
      for (const each of batch)
        if (each.status === 'fulfilled') read.push(each.value);
        else failure ??= each.reason;
      done(Math.min(tables.length, at + AT_ONCE));
    }
    if (failure !== undefined && !read.length) throw failure;
    return read;
  }

  private async one(workspace: string, session: string, table: DiagramTable, structured: boolean) {
    if (structured) {
      const answer = await this.api.execute<{ table: unknown }>('db.ddl.model', {
        workspace,
        session,
        path: table.path,
      });
      const model = readTable(answer.table);
      return tableFromModel(
        { ...model, name: model.name || table.name, schema: model.schema ?? table.schema },
        table.path,
      );
    }
    const described = await this.api.execute<Described>('db.describe', {
      workspace,
      session,
      path: table.path,
    });
    return tableFromDescription(described.sections ?? [], table.name, table.schema, table.path);
  }

  /** The tables that reference one, from its description (`references`). */
  async references(
    workspace: string,
    session: string,
    table: DiagramTable,
  ): Promise<DiagramTable[]> {
    const described = await this.api.execute<Described>('db.describe', {
      workspace,
      session,
      path: table.path,
    });
    const section = described.sections?.find((each) => each.id === 'references');
    if (!section) return [];
    const at = (name: string) => section.columns.indexOf(name);
    const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
    const seen = new Set<string>();
    return section.rows.flatMap((row) => {
      const name = text(row[at('Table name')]);
      const schema = at('Schema') >= 0 ? text(row[at('Schema')]) : '';
      if (!name || seen.has(`${schema}.${name}`)) return [];
      seen.add(`${schema}.${name}`);
      return [siblingTable(table, name, schema)];
    });
  }

  /** A table and those one step away: the ones it references and the ones referencing it. */
  async related(
    workspace: string,
    session: string,
    table: DiagramTable,
    structured: boolean,
    done?: (count: number) => void,
  ): Promise<ErdTable[]> {
    const [own] = await this.read(workspace, session, [table], structured);
    const parents = own.keys.map((key) =>
      siblingTable(table, key.referencedTable, key.referencedSchema),
    );
    const children = await this.references(workspace, session, table);
    const seen = new Set([own.entity.key, entityKey(table.name, table.schema)]);
    const others = [...parents, ...children].filter((other) => {
      const key = entityKey(other.name, other.schema);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [own, ...(await this.read(workspace, session, others, structured, done))];
  }

  save(
    workspace: string,
    id: string,
    name: string,
    value: DiagramValue,
    existing?: WorkspaceDocument,
  ) {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'db-diagram',
      name: name.trim() || 'Diagram',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value,
    });
  }

  remove(document: WorkspaceDocument) {
    return this.api.remove(document);
  }
}
