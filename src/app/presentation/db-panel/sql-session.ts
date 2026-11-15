import { signal } from '@angular/core';
import {
  DbServerInfo,
  TransactionState,
  editorSession,
} from '../../application/database-use-cases';
import { autoCommits, readDbConnection } from '../../domain/db/connection';
import { DEFAULT_MAX_RESULTS, ResultTab } from '../../domain/db/results';
import type { DbSection } from './section';
import { SqlResults } from './sql-results';

/**
 * The session of a SQL tab (`editor:<tab>`), opened the first time something runs: on its
 * database, with the commit mode of its connection; its transaction and its results.
 */
export abstract class SqlSession {
  readonly status = signal<'closed' | 'opening' | 'open' | 'error'>('closed');
  readonly server = signal<DbServerInfo | undefined>(undefined);
  readonly transaction = signal<TransactionState | undefined>(undefined);
  /** The run name of the statement running, to cancel it. */
  readonly running = signal('');
  readonly session: string;
  readonly results: SqlResults;
  maxResults = DEFAULT_MAX_RESULTS;

  constructor(
    protected readonly section: DbSection,
    readonly tab: string,
  ) {
    this.session = editorSession(tab);
    this.results = new SqlResults({
      cases: section.cases,
      workspace: () => section.state.workspaceId(),
      session: this.session,
      max: () => this.maxResults,
      rerun: (result) => this.rerun(result),
    });
  }

  /** Runs a result's statement again into its own tab. */
  abstract rerun(tab: ResultTab): Promise<void>;

  protected workspace() {
    return this.section.state.workspaceId();
  }
  connection() {
    const tab = this.section.tabs.tabs().find((other) => other.id === this.tab);
    return tab ? this.section.connection(tab.connection) : undefined;
  }
  driver() {
    return readDbConnection(this.connection()?.value).driver;
  }

  /** How the connection writes SQL, as its driver said. */
  sqlStyle() {
    return this.section.sqlStyle(this.connection()?.id ?? '');
  }

  /** Keeps the most result tabs, for this editor and the next ones. */
  async setMaxResults(count: number) {
    this.maxResults = count;
    (await this.section.cases()).statements.setMaxResults(count);
  }

  /** Opens the session the first time something runs, with its module and commit mode. */
  async open(): Promise<boolean> {
    if (this.status() === 'open') return true;
    const connection = this.connection();
    if (!connection) return false;
    this.status.set('opening');
    try {
      if (!(await this.section.ensure(this.driver()))) {
        this.status.set('closed');
        return false;
      }
      const cases = await this.section.cases();
      this.maxResults = cases.statements.maxResults();
      await this.section.learnQuotes(connection.id).catch(() => undefined);
      const value = readDbConnection(connection.value);
      const { server, transaction } = await cases.statements.open(
        this.workspace(),
        connection,
        this.session,
        this.section.state.scopes(),
        { database: this.section.tabs.draft(this.tab).database, manual: !autoCommits(value) },
      );
      this.server.set(server);
      this.transaction.set(transaction);
      this.status.set('open');
      return true;
    } catch (error) {
      this.status.set('error');
      this.results.note({ kind: 'error', text: this.section.state.describe(error) });
      return false;
    }
  }

  /** Opens the session again on another database of the server. */
  async useDatabase(database: string) {
    this.section.tabs.setDraft(this.tab, { database: database.trim() || undefined });
    await this.close();
    await this.open();
  }

  async close() {
    this.results.sessionLost();
    if (this.status() !== 'open') return this.status.set('closed');
    this.status.set('closed');
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }

  async dispose() {
    this.results.dispose();
    await this.close();
  }

  async cancel() {
    const run = this.running();
    if (!run) return;
    const cases = await this.section.cases();
    await cases.statements.cancel(this.workspace(), this.session, run).catch(() => undefined);
  }

  async refreshTransaction() {
    const cases = await this.section.cases();
    this.transaction.set(
      await cases.statements.transaction(this.workspace(), this.session, 'status'),
    );
  }

  /** Commits, rolls back, or changes between automatic and manual commits. */
  async transact(action: 'commit' | 'rollback' | 'auto' | 'manual') {
    if (!(await this.open())) return;
    const cases = await this.section.cases();
    try {
      this.transaction.set(
        await cases.statements.transaction(this.workspace(), this.session, action),
      );
      if (action === 'commit' || action === 'rollback')
        this.results.note({
          kind: 'info',
          text: action === 'commit' ? 'Committed' : 'Rolled back',
        });
    } catch (error) {
      this.results.note({ kind: 'error', text: this.section.state.describe(error) });
    }
  }
}
