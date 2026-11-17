import { DestroyRef, inject, signal } from '@angular/core';
import type {
  PendingTransaction,
  TransactionAction,
  TransactionLimits,
} from '../../application/database-use-cases';
import type { DbSection } from './section';
import type { SqlRunner } from './sql-runner';
import { hasPendingWrites } from './sql-transaction';

/** How often open transactions are looked at. */
const TICK_MS = 30_000;
const MINUTE_MS = 60_000;

/**
 * The transactions of the section's SQL tabs, as DBeaver keeps them in view: a transaction
 * open too long is pointed out (it may block others) and, when the person asked for it,
 * rolled back by itself; closing a tab with changes pending asks what to do with them; and
 * the pending transactions of every session can be committed or rolled back from one list.
 */
export class SectionTransactions {
  /** The clock the warnings read. */
  readonly now = signal(Date.now());
  readonly limits = signal<TransactionLimits>({ warnMinutes: 10, rollbackMinutes: 0 });
  /** The list of pending transactions, while it is shown. */
  readonly pending = signal<readonly PendingTransaction[] | undefined>(undefined);
  /** What the list shows: every session, or the log of one SQL tab's session. */
  readonly shown = signal<{ session?: string } | undefined>(undefined);
  /** The SQL tab being closed with changes pending, while the person decides. */
  readonly closing = signal<string | undefined>(undefined);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly section: DbSection) {
    this.start();
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Starts looking at the open transactions; `stop` ends it with the section. */
  start() {
    void this.section
      .cases()
      .then((cases) => this.limits.set(cases.statements.transactionLimits()));
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Minutes a SQL tab's transaction has been open. */
  minutes(runner: SqlRunner): number {
    const since = runner.transaction()?.since;
    return since ? Math.floor((this.now() - since) / MINUTE_MS) : 0;
  }
  /** Whether it has been open long enough to point it out. */
  isLong(runner: SqlRunner): boolean {
    const warn = this.limits().warnMinutes;
    return !!runner.transaction()?.open && warn > 0 && this.minutes(runner) >= warn;
  }

  /** Whether any SQL tab has changes a rollback would undo, to warn before leaving. */
  anyPending(): boolean {
    return this.section.editors.all().some((runner) => hasPendingWrites(runner.transaction()));
  }

  async tick() {
    this.now.set(Date.now());
    const rollback = this.limits().rollbackMinutes;
    if (!rollback) return;
    for (const runner of this.section.editors.all())
      if (runner.transaction()?.open && this.minutes(runner) >= rollback) {
        await runner.transact('rollback');
        runner.results.note({
          kind: 'warning',
          text: 'db.transaction.rolledBackAlone',
          params: { v0: String(rollback) },
        });
      }
  }

  async setLimits(limits: TransactionLimits) {
    this.limits.set(limits);
    (await this.section.cases()).statements.setTransactionLimits(limits);
  }

  /** Closes a tab; one whose transaction has changes asks first. */
  requestClose(tab: string) {
    const kind = this.section.tabs.tabs().find((other) => other.id === tab)?.kind;
    const unsaved = kind === 'diagram' && this.section.diagrams.unsaved(tab);
    if (unsaved && !this.section.state.confirm('Close the diagram without saving its changes?'))
      return;
    const runner = kind === 'sql' ? this.section.editors.runner(tab) : undefined;
    const shared = runner && this.section.editors.sharing(runner.session, tab).length > 0;
    if (runner && !shared && hasPendingWrites(runner.transaction())) this.closing.set(tab);
    else this.section.closeTab(tab);
  }
  /** What the person chose for the changes of the tab being closed. */
  async answerClose(choice: 'commit' | 'rollback' | 'cancel') {
    const tab = this.closing();
    this.closing.set(undefined);
    if (!tab || choice === 'cancel') return;
    const runner = this.section.editors.runner(tab);
    await runner.transact(choice);
    if (!runner.transaction()?.open) this.section.closeTab(tab);
  }

  /** Shows the pending transactions, or the log of one session's. */
  async show(session?: string) {
    await this.load();
    this.shown.set({ ...(session ? { session } : {}) });
  }
  hide() {
    this.shown.set(undefined);
    this.pending.set(undefined);
  }

  /** Reads every session's pending transaction, for the list. */
  async load() {
    const cases = await this.section.cases();
    this.pending.set(await cases.statements.openTransactions(this.section.state.workspaceId()));
  }
  /** Commits or rolls back a session's transaction from the list. */
  async act(session: string, action: Extract<TransactionAction, 'commit' | 'rollback'>) {
    const tab = this.section.editors.all().find((runner) => runner.session === session);
    if (tab) await tab.transact(action);
    else {
      const cases = await this.section.cases();
      await cases.statements.transaction(this.section.state.workspaceId(), session, action);
    }
    await this.load();
  }
}
