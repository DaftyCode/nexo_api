import { DbNode } from '../../domain/db/tree';
import type { ExportFormat } from '../../domain/db/transfer/export';
import { NavigatorRow } from '../../domain/db/rows';
import { tableOfPath } from '../../domain/db/table-query';
import type { DbSection } from './section';

export type TransferKind = 'export' | 'import' | 'copy';

/** What a transfer starts from: a table of the tree, or the query of a result. */
export interface TransferRequest {
  kind: TransferKind;
  connection: string;
  /** What is read (export, copy): the table's rows or the result's query. */
  sql: string;
  /** For the file's name and the target table's. */
  name: string;
  /** The table of the tree: where an import writes, and how SQL names it. */
  table?: { schema?: string; name: string; qualified: string };
  /** The export's format, as `@export` names it. */
  format?: ExportFormat;
}

/** The schema and name of a table of the tree, as its path and nodes say them. */
export function tableEnds(path: readonly string[], nodes: readonly DbNode[]) {
  const object = nodes.at(-1);
  const schema = [...nodes.slice(0, -1)].reverse().find((node) => node.kind === 'schema');
  if (object && schema) return { schema: schema.label, name: object.label };
  const [name, , schemaName] = [...path].reverse();
  return { ...(schemaName ? { schema: schemaName } : {}), name: object?.label ?? name };
}

/** Opens the transfer wizard on a table of the tree. */
export async function openTransfer(section: DbSection, row: NavigatorRow, kind: TransferKind) {
  if (!row.connection || !row.path) return;
  const connection = row.connection;
  await section.learnQuotes(connection).catch(() => undefined);
  const nodes = section.nodesAlong(connection, row.path);
  const qualified = tableOfPath(row.path, nodes, section.sqlStyle(connection));
  section.transferRequest.set({
    kind,
    connection,
    sql: `SELECT * FROM ${qualified}`,
    name: row.label,
    table: { ...tableEnds(row.path, nodes), qualified },
  });
}
