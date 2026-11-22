import { signal } from '@angular/core';
import type { RestAnswer } from '../../application/database-use-cases';
import { typedConfirmation } from '../../domain/db/keyvalue';
import { RestBlock, RestBodyError, restBody } from '../../domain/db/rest-console';
import type { DbSection } from './section';

/** Requests kept in the history of a console. */
const HISTORY = 50;

/**
 * The console of Query DSL of a connection open in a tab (DB-36), on its own session: the
 * answer of the request last run, its history, and what waits to be confirmed (the name of
 * an index to delete typed, or a change on production).
 */
export class RestRun {
  readonly session: string;
  readonly status = signal<'closed' | 'opening' | 'open' | 'error'>('closed');
  readonly error = signal('');
  readonly running = signal(false);
  readonly answer = signal<(RestAnswer & { request: string }) | undefined>(undefined);
  readonly history = signal<readonly string[]>([]);
  /** A request that waits for the name it deletes, empties or closes, typed. */
  readonly waiting = signal<{ block: RestBlock; name: string } | undefined>(undefined);
  /** The indices of the cluster, for completion. */
  readonly indices = signal<readonly string[]>([]);

  constructor(
    readonly section: DbSection,
    readonly tab: string,
  ) {
    this.session = `rest:${tab}`;
  }

  private workspace() {
    return this.section.state.workspaceId();
  }

  /** Opens the session and reads the names of the indices. */
  async start() {
    if (this.status() !== 'closed') return;
    this.status.set('opening');
    try {
      const tab = this.section.tabs.tabs().find((each) => each.id === this.tab);
      const connection = tab && this.section.connection(tab.connection);
      if (!tab || !connection) throw new Error('The connection is no longer there');
      if (!(await this.section.ensure(this.section.driverOf(tab.connection))))
        throw new Error('db.dashboard.module');
      const cases = await this.section.cases();
      await cases.statements.open(
        this.workspace(),
        connection,
        this.session,
        this.section.state.scopes(),
        { manual: false },
      );
      this.status.set('open');
      const indices = await cases.rest.request(this.workspace(), this.session, {
        method: 'GET',
        path: '_cat/indices?format=json&h=index',
      });
      const rows = Array.isArray(indices.body) ? (indices.body as { index?: string }[]) : [];
      this.indices.set(rows.map((row) => String(row.index ?? '')).filter(Boolean));
    } catch (error) {
      this.status.set(this.status() === 'opening' ? 'error' : this.status());
      this.error.set(this.section.state.describe(error));
    }
  }

  /** Runs a request; `confirmName` is what it deletes, typed. */
  async run(block: RestBlock, confirmName?: string) {
    if (this.running()) return;
    this.error.set('');
    this.waiting.set(undefined);
    let body: unknown;
    try {
      body = restBody(block);
    } catch (error) {
      this.error.set(error instanceof RestBodyError ? error.message : String(error));
      return;
    }
    const line = `${block.method} ${block.path}`;
    this.history.update((all) => [line, ...all.filter((each) => each !== line)].slice(0, HISTORY));
    this.running.set(true);
    try {
      const cases = await this.section.cases();
      const call = { method: block.method, path: block.path, body };
      const send = (confirm?: boolean) =>
        cases.rest.request(this.workspace(), this.session, call, { confirm, confirmName });
      const answer = await send().catch(async (error: unknown) => {
        const message = this.section.state.describe(error);
        const name = typedConfirmation(message);
        if (name) {
          this.waiting.set({ block, name });
          return undefined;
        }
        if (
          /asks to confirm each change/.test(message) &&
          this.section.state.confirm('db.edit.confirmProduction')
        )
          return send(true);
        throw error;
      });
      if (answer) this.answer.set({ ...answer, request: line });
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    } finally {
      this.running.set(false);
    }
  }

  async stop() {
    const was = this.status();
    this.status.set('closed');
    if (was !== 'open') return;
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }
}
