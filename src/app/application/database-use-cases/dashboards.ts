import { Panel, readPanels, readingOf } from '../../domain/db/dashboard';
import { ExecutionPort } from '../ports';

/** Names of the readings, to cancel one that hangs. */
let readings = 0;

/**
 * The dashboard of a server (DB-22): the panels its driver offers, and a reading of one
 * panel on the dashboard's own session. The application refuses a query that does not only
 * read, and records no reading in the history.
 */
export class DatabaseDashboardCases {
  constructor(private readonly api: ExecutionPort) {}

  async panels(workspace: string, session: string): Promise<Panel[]> {
    return readPanels(await this.api.execute('db.dashboards', { workspace, session }));
  }

  /** The values a panel's query reads now, by series. */
  async read(workspace: string, session: string, sql: string): Promise<Record<string, number>> {
    const answer = await this.api.execute<{
      columns?: { name: string }[];
      rows?: unknown[][];
    }>('db.dashboard.read', { workspace, session, statement: `panel-${++readings}`, sql });
    return readingOf(answer?.columns ?? [], answer?.rows ?? []);
  }
}
