import { treeSession } from '../../application/database-use-cases';
import { NavigatorRow } from '../../domain/db/rows';
import { databaseOf } from '../../domain/db/sql';
import { Generated, generateFor } from '../../domain/db/sql-generate';
import { tableOfPath } from '../../domain/db/table-query';
import type { DbSection } from './section';

/**
 * «Generate SQL» of a table or view of the tree, as DBeaver's: its columns and key read with
 * a statement that returns no row (as every engine answers), and the statement opened in a
 * new script, on the database the table is in.
 */
export async function generateSql(section: DbSection, row: NavigatorRow, kind: Generated) {
  if (!row.connection || !row.path) return;
  const connection = row.connection;
  await section.learnQuotes(connection).catch(() => undefined);
  const nodes = section.nodesAlong(connection, row.path);
  const style = section.sqlStyle(connection);
  const qualified = tableOfPath(row.path, nodes, style);
  const cases = await section.cases();
  const answer = await cases.statements.execute(
    section.state.workspaceId(),
    treeSession(connection),
    `generate-${Date.now()}`,
    `SELECT * FROM ${qualified} WHERE 1 = 0`,
    { pageRows: 1 },
  );
  const text = generateFor(
    {
      name: row.label,
      qualified,
      columns: answer.columns.map((column) => ({ name: column.name, key: !!column.key })),
    },
    kind,
    style,
  );
  const database = databaseOf(nodes);
  section.newScript(connection, { text, ...(database ? { database } : {}) });
}
