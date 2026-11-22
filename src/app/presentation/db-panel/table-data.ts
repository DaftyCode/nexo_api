import { signal } from '@angular/core';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { ResultColumn, cellText } from '../../domain/db/results';
import {
  ForeignKey,
  TableQuery,
  emptyTableQuery,
  tableCount,
  tableSelect,
} from '../../domain/db/table-query';
import { quoteName } from '../../domain/db/tree';
import { autoCommits, readDbConnection } from '../../domain/db/connection';
import { RowEditor } from './row-editor';
import type { DbSection } from './section';

/** Rows read at a time in the «Data» tab unless the person picks other, and those shown of
 * each related table. */
export const PAGE = 200;
export const PAGES = [50, 100, 200, 500, 1000];
const RELATED = 50;

/** The rows of a table related to the active row by one of its foreign keys. */
export interface RelatedRows {
  key: ForeignKey;
  /** `parent`: the row this one points to; `child`: the rows that point to this one. */
  direction: 'parent' | 'child';
  columns: ResultColumn[];
  rows: unknown[][];
}

/**
 * The «Data» tab of an object: its rows read by pages on its own session (`object:<tab>`),
 * on the database the object is in, with the filter and order asked of the server; their
 * count; refreshing, now or every so many seconds; and the rows related by its keys.
 */
export class TableData {
  readonly columns = signal<readonly ResultColumn[]>([]);
  readonly rows = signal<readonly unknown[][]>([]);
  readonly cursor = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly count = signal<number | undefined>(undefined);
  /** The statement last run, to see it or open it in a script. */
  readonly statement = signal('');
  readonly view = signal<GridView>(emptyView());
  readonly every = signal(0);
  /** Rows read at a time, and how long the server took to answer the last statement. */
  readonly page = signal(PAGE);
  readonly elapsed = signal<number | undefined>(undefined);
  readonly related = signal<readonly RelatedRows[]>([]);
  readonly session: string;
  /** Its rows edited in the grid before they are saved. */
  readonly editor: RowEditor;
  private opened = false;
  private timer?: ReturnType<typeof setInterval>;
  private runs = 0;

  constructor(
    private readonly section: DbSection,
    readonly tab: string,
    private readonly source: () => {
      connection: string;
      table: string;
      database: string;
      query: TableQuery;
    },
  ) {
    this.session = `object:${tab}`;
    this.editor = new RowEditor(section, {
      columns: () => this.columns(),
      rows: () => this.rows(),
      connection: () => this.source().connection,
      session: () => this.session,
      reload: () => this.load(),
    });
  }

  private workspace() {
    return this.section.state.workspaceId();
  }
  private style() {
    return this.section.sqlStyle(this.source().connection);
  }
  query() {
    return this.source().query ?? emptyTableQuery();
  }

  private async open() {
    if (this.opened) return true;
    const { connection, database } = this.source();
    const document = this.section.connection(connection);
    if (!document || !(await this.section.ensure(this.section.driverOf(connection)))) return false;
    const cases = await this.section.cases();
    await this.section.learnQuotes(connection).catch(() => undefined);
    await cases.statements.open(
      this.workspace(),
      document,
      this.session,
      this.section.state.scopes(),
      {
        ...(database ? { database } : {}),
        // Saved edits wait for a commit when the connection commits by hand (DB-13).
        manual: !autoCommits(readDbConnection(document.value), this.section.rulesOf(document.id)),
      },
    );
    this.opened = true;
    return true;
  }

  private async run(sql: string, params: unknown[], pageRows = this.page()) {
    const cases = await this.section.cases();
    return cases.statements.execute(
      this.workspace(),
      this.session,
      `${this.tab}-${++this.runs}`,
      sql,
      {
        pageRows,
        ...(params.length ? { params } : {}),
      },
    );
  }

  /** The table as the statement names it, quoted as its engine wants. */
  table() {
    return this.source().table;
  }
  /** The statement the rows are read with, as the filter and order stand now. */
  select() {
    return tableSelect(this.source().table, this.query(), this.style()).sql;
  }

  /** Reads the first page again with the filter and order of the tab. */
  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      if (!(await this.open())) return;
      const old = this.cursor();
      if (old) await this.closeCursor(old);
      const { sql, params } = tableSelect(this.source().table, this.query(), this.style());
      this.statement.set(sql);
      const answer = await this.run(sql, params);
      this.columns.set(answer.columns);
      this.rows.set(answer.rows);
      this.cursor.set(answer.cursor ?? undefined);
      this.elapsed.set(answer.elapsedMs);
      this.count.set(undefined);
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  async more() {
    const cursor = this.cursor();
    if (!cursor || this.loading()) return;
    this.loading.set(true);
    try {
      const cases = await this.section.cases();
      const page = await cases.statements.fetch(
        this.workspace(),
        this.session,
        cursor,
        this.page(),
      );
      this.rows.update((rows) => [...rows, ...page.rows]);
      this.cursor.set(page.cursor ?? undefined);
    } catch (error) {
      this.cursor.set(undefined);
      this.error.set(this.section.state.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** Counts the rows the filter keeps, with `count(*)` on the server. */
  async countRows() {
    try {
      if (!(await this.open())) return;
      const { sql, params } = tableCount(this.source().table, this.query(), this.style());
      const answer = await this.run(sql, params, 1);
      this.count.set(Number(cellText(answer.rows[0]?.[0])));
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    }
  }

  /** Refreshes every `seconds`; 0 stops it. */
  refreshEvery(seconds: number) {
    clearInterval(this.timer);
    this.every.set(seconds);
    if (seconds > 0) this.timer = setInterval(() => void this.load(), seconds * 1000);
  }

  /**
   * The rows related to a row by each key: the row it points to by its own keys, and the
   * first rows of each table that points to it.
   */
  async relate(row: number, parents: readonly ForeignKey[], children: readonly ForeignKey[]) {
    const values = this.rows()[row];
    if (!values) return this.related.set([]);
    const style = this.style();
    const at = (name: string) => this.columns().findIndex((column) => column.name === name);
    const found: RelatedRows[] = [];
    for (const [direction, keys] of [
      ['parent', parents],
      ['child', children],
    ] as const)
      for (const key of keys) {
        const [mine, theirs] =
          direction === 'parent' ? [key.columns, key.referenced] : [key.referenced, key.columns];
        if (mine.some((name) => at(name) < 0)) continue;
        const table = [key.schema, key.table]
          .filter(Boolean)
          .map((part) => quoteName(part, style))
          .join('.');
        const query = {
          where: '',
          order: [],
          quick: theirs.map((column, index) => ({
            column,
            operator: 'eq' as const,
            value: values[at(mine[index])],
          })),
        };
        try {
          const { sql, params } = tableSelect(table, query, style);
          const answer = await this.run(sql, params, RELATED);
          if (answer.cursor) await this.closeCursor(answer.cursor);
          found.push({ key, direction, columns: answer.columns, rows: answer.rows });
        } catch {
          // A table the person may not read is left out.
        }
      }
    this.related.set(found);
  }

  private async closeCursor(cursor: string) {
    const cases = await this.section.cases();
    await cases.statements.closeCursor(this.workspace(), this.session, cursor);
    this.cursor.set(undefined);
  }

  async dispose() {
    clearInterval(this.timer);
    if (!this.opened) return;
    this.opened = false;
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }
}
