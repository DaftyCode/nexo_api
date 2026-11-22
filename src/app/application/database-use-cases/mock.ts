import type { ExecuteAnswer } from '../../domain/db/results';
import { TableModel, readTable } from '../../domain/db/structure';
import { quoteName } from '../../domain/db/tree';
import type { SqlStyle } from '../../domain/db/grid/copy';
import type { ForeignKeyModel } from '../../domain/db/structure';
import type { DatabasePorts } from './connections';

/** Keys of a referenced table read, at most. */
const KEYS = 10_000;

/** What a batch written answered: rows in, rows refused, and the first reasons. */
export interface MockBatch {
  inserted: number;
  failed: number;
  failures: { position: number; error: string }[];
}

/**
 * Test data (DB-27): the structure of a table, the keys of the tables it references, batches
 * of rows to see or to write (`db.mock.rows`), and emptying the table first, which asks for
 * its name as any statement that empties one.
 */
export class DatabaseMockCases {
  constructor(private readonly api: Pick<DatabasePorts, 'execute'>) {}

  async structure(
    workspace: string,
    session: string,
    path: readonly string[],
  ): Promise<TableModel> {
    const answer = await this.api.execute<{ table: unknown }>('db.ddl.model', {
      workspace,
      session,
      path,
    });
    return readTable(answer.table);
  }

  /** The values of the key a foreign column references, up to ten thousand. */
  async keys(
    workspace: string,
    session: string,
    key: ForeignKeyModel,
    style: SqlStyle,
  ): Promise<unknown[]> {
    const table = [key.referencedSchema, key.referencedTable]
      .filter((part): part is string => !!part)
      .map((part) => quoteName(part, style))
      .join('.');
    const column = quoteName(key.referencedColumns[0] ?? 'id', style);
    const sql =
      style.name === 'tsql'
        ? `SELECT DISTINCT TOP (${KEYS}) ${column} FROM ${table}`
        : `SELECT DISTINCT ${column} FROM ${table} LIMIT ${KEYS}`;
    const statement = `mock-keys-${Math.random().toString(36).slice(2)}`;
    const answer = await this.api.execute<ExecuteAnswer>('db.execute', {
      workspace,
      session,
      statement,
      sql,
      pageRows: KEYS,
    });
    if (answer.cursor)
      await this.api
        .execute('db.close', { workspace, session, cursor: answer.cursor })
        .catch(() => undefined);
    return answer.rows.map((row) => row[0]).filter((value) => value !== null);
  }

  /** Rows `first` to `first + count - 1` of the run with `seed`: shown, or written. */
  rows<T = { columns: string[]; rows: unknown[][] }>(
    workspace: string,
    session: string,
    table: { schema?: string; name: string },
    columns: readonly Record<string, unknown>[],
    run: { seed: number; first: number; count: number; write?: boolean },
  ): Promise<T> {
    return this.api.execute<T>('db.mock.rows', {
      workspace,
      session,
      table: table.name,
      ...(table.schema ? { schema: table.schema } : {}),
      columns,
      ...run,
    });
  }

  /** Empties the table before writing, once its name is typed. */
  async empty(
    workspace: string,
    session: string,
    qualified: string,
    name: string,
    style: SqlStyle,
  ) {
    const sql =
      style.name === 'sqlite' ? `DELETE FROM ${qualified}` : `TRUNCATE TABLE ${qualified}`;
    await this.api.execute('db.execute', {
      workspace,
      session,
      statement: `mock-empty-${Math.random().toString(36).slice(2)}`,
      sql,
      confirm: true,
      confirmName: name,
    });
  }
}
