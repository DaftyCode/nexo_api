import { signal } from '@angular/core';
import {
  DbServerInfo,
  TransactionAction,
  TransactionState,
  editorSession,
  sharedSession,
} from '../../application/database-use-cases';
import { autoCommits, readDbConnection } from '../../domain/db/connection';
import { DEFAULT_MAX_RESULTS, ResultTab } from '../../domain/db/results';
import type { ParameterStyle } from '../../domain/db/sql-params';
import { RowEditor } from './row-editor';
import type { DbSection } from './section';
import { SqlResults } from './sql-results';

/**
 * The session of a SQL tab (`editor:<tab>`, or the one the tabs of its connection share when
 * the connection asks), opened the first time something runs: on its database, with the
 * commit mode of its connection; its transaction and its results.
 */
export abstract class SqlSession {
  readonly status = signal<'closed' | 'opening' | 'open' | 'error'>('closed');
  readonly server = signal<DbServerInfo | undefined>(undefined);
  readonly transaction = signal<TransactionState | undefined>(undefined);
  /** The run name of the statement running, to cancel it. */
  readonly running = signal('');
  /** The isolation level the next transaction begins with; empty for the server's own. */
  readonly isolation = signal('');
  readonly session: string;
  readonly results: SqlResults;
  maxResults = DEFAULT_MAX_RESULTS;

  constructor(
    readonly section: DbSection,
    readonly tab: string,
  ) {
    const connection = this.connection();
    this.session =
      connection && readDbConnection(connection.value).sharedSession
        ? sharedSession(connection.id)
        : editorSession(tab);
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

  private readonly editors = new Map<string, RowEditor>();
  /** The rows of a result tab edited in the grid, when they can be (one table, its key). */
  editorOf(tab: string): RowEditor {
    let editor = this.editors.get(tab);
    if (!editor) {
      const result = () => this.results.tabs().find((each) => each.id === tab);
      editor = new RowEditor(this.section, {
        columns: () => result()?.columns ?? [],
        rows: () => result()?.rows ?? [],
        connection: () => this.connection()?.id ?? '',
        session: () => this.session,
        reload: async () => {
          const found = result();
          if (found) await this.rerun(found);
        },
      });
      this.editors.set(tab, editor);
    }
    return editor;
  }

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

  /** How the driver binds parameters: `$1`, `?` or `@P1`. */
  parameterStyle(): ParameterStyle {
    const style = (this.sqlStyle() as { parameters?: string }).parameters;
    return style === 'numbered' || style === 'named' ? style : 'question';
  }

  /** Keeps the most result tabs, for this editor and the next ones. */
  async setMaxResults(count: number) {
    this.maxResults = count;
    (await this.section.cases()).statements.setMaxResults(count);
  }

  /** The opening under way, which a second caller (the completion) waits for. */
  private opening?: Promise<boolean>;

  /** Opens the session the first time something runs, with its module and commit mode. */
  open(): Promise<boolean> {
    if (this.status() === 'open') return Promise.resolve(true);
    this.opening ??= this.openOnce().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async openOnce(): Promise<boolean> {
    // A session another tab shares is already open: its transaction is this tab's too.
    const partner = this.section.editors.sharing(this.session, this.tab)[0];
    if (partner) {
      this.server.set(partner.server());
      this.transaction.set(partner.transaction());
      this.status.set('open');
      return true;
    }
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
      for (const failed of server.startup ?? [])
        this.results.note({
          kind: 'warning',
          text: 'db.startup.failed',
          params: { v0: failed.sql, v1: failed.error },
        });
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

  /** Closes the session; one another tab shares stays open for it. */
  async close() {
    this.results.sessionLost();
    if (this.status() !== 'open') return this.status.set('closed');
    this.status.set('closed');
    if (this.section.editors.sharing(this.session, this.tab).length) return;
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }

  async dispose() {
    this.results.dispose();
    await this.close();
  }

  /** What a transaction action answered, for this tab and the tabs sharing its session. */
  protected noteTransaction(state: TransactionState) {
    this.transaction.set(state);
    for (const other of this.section.editors.sharing(this.session, this.tab))
      other.transaction.set(state);
  }

  async cancel() {
    const run = this.running();
    if (!run) return;
    const cases = await this.section.cases();
    await cases.statements.cancel(this.workspace(), this.session, run).catch(() => undefined);
  }

  async refreshTransaction() {
    const cases = await this.section.cases();
    this.noteTransaction(
      await cases.statements.transaction(this.workspace(), this.session, 'status'),
    );
  }

  /**
   * Commits, rolls back, begins (with the chosen isolation level), or changes between
   * automatic and manual commits.
   */
  async transact(action: Exclude<TransactionAction, 'status'>) {
    if (!(await this.open())) return;
    const cases = await this.section.cases();
    try {
      const isolation = action === 'begin' ? this.isolation() || undefined : undefined;
      this.noteTransaction(
        await cases.statements.transaction(this.workspace(), this.session, action, isolation),
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
