import { SchemaTable } from '../../domain/db/completion';
import { DbNode } from '../../domain/db/tree';
import type { DbSection } from './section';

/** A table the editor knows, and where it is in the tree. */
export interface KnownTable extends SchemaTable {
  path: string[];
}
interface Described {
  sections: { id: string; columns: string[]; rows: unknown[][] }[];
}

/** Tree calls a first look may make, at most, to find the tables of a connection. */
const LOOKS = 40;
/** Folders and kinds of node that lead to tables. */
const LEADS = new Set(['databases', 'schemas', 'tables', 'views']);

const text = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? String((value as { v?: unknown }).v ?? '')
      : String(value);

/** The schema a table's path says it is in: the segment before its folder of tables. */
function schemaOf(path: readonly string[]): string | undefined {
  const folder = path.length - 2;
  return folder >= 1 &&
    LEADS.has(path[folder]) &&
    path[folder - 1] !== undefined &&
    path[folder - 2] !== undefined
    ? path[folder - 1]
    : undefined;
}

/**
 * What the SQL editor knows of the schema of each connection, as DBeaver's metadata cache:
 * its tables and views (those the tree loaded, else the folders of tables of its database,
 * read once), and the columns and foreign keys of a table, read when they are needed.
 * Refreshing the tree empties it.
 */
export class SchemaCache {
  private readonly tables = new Map<string, Promise<KnownTable[]>>();
  private readonly details = new Map<string, Promise<KnownTable>>();

  constructor(private readonly section: DbSection) {}

  clear(connection: string) {
    this.tables.delete(connection);
    for (const key of [...this.details.keys()])
      if (key.startsWith(`${connection}\n`)) this.details.delete(key);
  }

  /** The tables of a connection, asked of `session` the first time. */
  tablesOf(connection: string, session: string, database?: string): Promise<KnownTable[]> {
    let found = this.tables.get(connection);
    if (!found) {
      found = this.look(session, database).catch(() => []);
      this.tables.set(connection, found);
    }
    return found;
  }

  /** A table with its columns and keys, read with `describe` once. */
  detail(connection: string, session: string, table: KnownTable): Promise<KnownTable> {
    const key = `${connection}\n${table.path.join('\n')}`;
    let found = this.details.get(key);
    if (!found) {
      found = this.describe(session, table).catch(() => table);
      this.details.set(key, found);
    }
    return found;
  }

  private async describe(session: string, table: KnownTable): Promise<KnownTable> {
    const cases = await this.section.cases();
    const described = await cases.navigator.describe<Described>(
      this.section.state.workspaceId(),
      session,
      table.path,
    );
    const section = (id: string) => described.sections.find((each) => each.id === id);
    const cell = (part: Described['sections'][number] | undefined, row: unknown[], name: string) =>
      text(row[part?.columns.indexOf(name) ?? -1]);
    const columns = section('columns');
    const keys = section('foreign-keys');
    const list = (value: string) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    return {
      ...table,
      columns: (columns?.rows ?? []).map((row) => ({
        name: cell(columns, row, 'Name'),
        type: cell(columns, row, 'Type'),
      })),
      keys: (keys?.rows ?? []).map((row) => ({
        columns: list(cell(keys, row, 'Columns')),
        table: cell(keys, row, 'Referenced table'),
        referenced: list(cell(keys, row, 'Referenced columns')),
      })),
    };
  }

  /** The tables the tree loaded; else the folders that lead to them, on its database only. */
  private async look(session: string, database?: string): Promise<KnownTable[]> {
    const cases = await this.section.cases();
    const workspace = this.section.state.workspaceId();
    const found: KnownTable[] = [];
    let looks = 0;
    const walk = async (path: string[], depth: number): Promise<void> => {
      if (looks++ >= LOOKS || depth > 5) return;
      const nodes: DbNode[] = await cases.navigator.tree(workspace, session, path);
      const databases = nodes.filter((node) => node.kind === 'database');
      const own = databases.find((node) => node.name === database) ?? databases[0];
      for (const node of nodes) {
        if (node.system) continue;
        const at = [...path, node.name];
        if (node.kind === 'table' || node.kind === 'view')
          found.push({ name: node.name, schema: schemaOf(at), kind: node.kind, path: at });
        else if (
          node.kind === 'database' ? node === own : node.kind === 'schema' || LEADS.has(node.name)
        )
          await walk(at, depth + 1);
      }
    };
    await walk([], 0);
    return found;
  }
}
