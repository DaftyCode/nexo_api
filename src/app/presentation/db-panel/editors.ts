import { readDbConnection } from '../../domain/db/connection';
import { databaseOf } from '../../domain/db/sql';
import { emptyTableQuery, tableOfPath } from '../../domain/db/table-query';
import type { DbSection } from './section';
import { SqlRunner } from './sql-runner';
import { TableData } from './table-data';

/**
 * What lives as long as an editor tab, even while another tab is shown: the runner of a
 * SQL tab and the «Data» of an object tab, each with its own session. Closing the tab
 * closes them.
 */
export class OpenEditors {
  private readonly runners = new Map<string, SqlRunner>();
  private readonly tables = new Map<string, TableData>();

  constructor(private readonly section: DbSection) {}

  runner(tab: string): SqlRunner {
    let runner = this.runners.get(tab);
    if (!runner) this.runners.set(tab, (runner = new SqlRunner(this.section, tab)));
    return runner;
  }

  /** The other SQL tabs whose session `session` is open, when their connection shares one. */
  sharing(session: string, except: string): SqlRunner[] {
    return [...this.runners.entries()]
      .filter(([tab, runner]) => tab !== except && runner.session === session)
      .map(([, runner]) => runner)
      .filter((runner) => runner.status() === 'open');
  }

  /** Every SQL tab open now, to find the transactions that wait. */
  all(): SqlRunner[] {
    return [...this.runners.values()];
  }

  /** The «Data» of an object tab: its table and database from the tab's path. */
  table(tab: string): TableData {
    let data = this.tables.get(tab);
    if (!data) {
      const source = () => {
        const current = this.section.tabs.tabs().find((other) => other.id === tab);
        const connection = current?.connection ?? '';
        const path = current?.path ?? [];
        const nodes = this.section.nodesAlong(connection, path);
        const own = readDbConnection(this.section.connection(connection)?.value).database ?? '';
        // Without the tree loaded, the database is the segment before `schemas` in the path.
        const schemas = path.indexOf('schemas');
        const database = databaseOf(nodes) || (schemas > 0 ? path[schemas - 1] : '');
        return {
          connection,
          table: tableOfPath(path, nodes, this.section.sqlStyle(connection)),
          database: database && database !== own ? database : '',
          query: current?.query ?? emptyTableQuery(),
        };
      };
      this.tables.set(tab, (data = new TableData(this.section, tab, source)));
    }
    return data;
  }

  close(tab: string) {
    void this.runners.get(tab)?.dispose();
    void this.tables.get(tab)?.dispose();
    this.runners.delete(tab);
    this.tables.delete(tab);
  }
}
