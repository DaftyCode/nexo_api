/**
 * Actions of a navigator node that copy it or open a script for it: its quoted name, its DDL,
 * the template of a new object of its folder, the refresh of a materialized view.
 */
import { NavigatorRow } from '../../domain/db/rows';
import { copiedName } from '../../domain/db/tree';
import { newObjectScript } from '../../domain/db/ddl-templates';
import { readDbConnection } from '../../domain/db/connection';
import { schemaOf } from '../../domain/db/object-properties';
import { databaseOf, qualifiedName } from '../../domain/db/sql';
import { PanelTask } from '../panel-task';
import { success } from '../workspace-state';
import type { DbSection } from './section';

async function copy(section: DbSection, text: string) {
  await globalThis.navigator?.clipboard?.writeText(text);
  section.state.tell(success('Copied to the clipboard'));
}

/** Copies a node's name, quoted as its engine quotes it. */
export function copyName(section: DbSection, task: PanelTask, row: NavigatorRow) {
  if (!row.node || !row.connection) return;
  const connection = row.connection;
  const node = row.node;
  void task.run(async () => {
    await section.learnQuotes(connection).catch(() => undefined);
    await copy(section, copiedName(node, section.quoteStyle(connection)));
  });
}

/** Copies a node's DDL, as its driver writes it. */
export function copyDdl(section: DbSection, task: PanelTask, row: NavigatorRow) {
  if (!row.connection || !row.path) return;
  const { connection, path } = row;
  void task.run(async () => {
    const cases = await section.cases();
    const sql = await cases.navigator.ddl(section.state.workspaceId(), `tree:${connection}`, path);
    await copy(section, sql);
  });
}

/** A new view, routine, sequence, trigger, schema or database: a script with its template. */
export async function newObject(section: DbSection, row: NavigatorRow) {
  const folder = row.node?.name;
  if (!row.connection || !row.path || !folder) return;
  const connection = row.connection;
  await section.learnQuotes(connection).catch(() => undefined);
  const script = newObjectScript(folder, section.sqlStyle(connection), schemaOf(row.path));
  if (script) open(section, connection, row.path, script, false);
}

/**
 * «View data», as DBeaver's SQL console: a SQL tab with `SELECT *` of the table or view, run
 * at once, on the database it is in.
 */
export async function viewData(section: DbSection, row: NavigatorRow) {
  if (!row.connection || !row.path) return;
  const connection = row.connection;
  await section.learnQuotes(connection).catch(() => undefined);
  const name = qualifiedName(
    section.nodesAlong(connection, row.path),
    section.quoteStyle(connection),
  );
  open(section, connection, row.path, `SELECT * FROM ${name}`, true);
}

/** «Refresh» of a materialized view, as DBeaver's: its statement, run under the usual rules. */
export async function refreshView(section: DbSection, row: NavigatorRow) {
  if (!row.connection || !row.path) return;
  const connection = row.connection;
  await section.learnQuotes(connection).catch(() => undefined);
  const name = qualifiedName(
    section.nodesAlong(connection, row.path),
    section.quoteStyle(connection),
  );
  open(section, connection, row.path, `REFRESH MATERIALIZED VIEW ${name}`, true);
}

/** A script on the database the node is in, when it is not the connection's own. */
function open(section: DbSection, connection: string, path: string[], text: string, run: boolean) {
  const database = databaseOf(section.nodesAlong(connection, path));
  const own = readDbConnection(section.connection(connection)?.value).database ?? '';
  section.newScript(connection, {
    text,
    run,
    ...(database && database !== own ? { database } : {}),
  });
}
