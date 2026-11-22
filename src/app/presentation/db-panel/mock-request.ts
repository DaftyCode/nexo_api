import { NavigatorRow } from '../../domain/db/rows';
import { tableOfPath } from '../../domain/db/table-query';
import type { DbSection } from './section';
import { tableEnds } from './transfer-request';

/** The table test data is made for (DB-27), as the tree and SQL name it. */
export interface MockRequest {
  connection: string;
  path: string[];
  table: { schema?: string; name: string; qualified: string };
}

/**
 * Whether a connection takes test data: never a read-only one, nor one whose type confirms
 * each change (production), as the backend also refuses.
 */
export function takesTestData(section: DbSection, connection: string | undefined): boolean {
  const document = connection ? section.connection(connection) : undefined;
  if (!document) return false;
  const readOnly = (document.value as { readOnly?: unknown }).readOnly === true;
  const rules = section.rulesOf(connection!);
  return !readOnly && !rules.readOnly && !rules.confirmWrites;
}

/** What the dialog of test data starts from: a table of the tree. */
export async function mockRequest(
  section: DbSection,
  row: NavigatorRow,
): Promise<MockRequest | undefined> {
  if (!row.connection || !row.path || !takesTestData(section, row.connection)) return undefined;
  await section.learnQuotes(row.connection).catch(() => undefined);
  const nodes = section.nodesAlong(row.connection, row.path);
  const qualified = tableOfPath(row.path, nodes, section.sqlStyle(row.connection));
  return {
    connection: row.connection,
    path: [...row.path],
    table: { ...tableEnds(row.path, nodes), qualified },
  };
}
