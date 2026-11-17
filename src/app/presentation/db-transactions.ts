import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { DbSection } from './db-panel/section';

/**
 * The transactions waiting for a commit or a rollback, as DBeaver's «Pending transactions»:
 * each session with its connection, since when, and the statements of its log, each with a
 * commit and a rollback; or the log of one SQL tab's transaction. Also when an open
 * transaction is pointed out, and rolled back by itself.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transactions',
  templateUrl: './db-transactions.html',
  styleUrl: './db-transactions.scss',
  host: { '(keydown.escape)': 'closed.emit()' },
})
export class DbTransactions {
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  protected readonly transactions = this.section.transactions;
  /** Only one session's, when the list was opened from a SQL tab. */
  protected readonly only = computed(() => this.transactions.shown()?.session);
  protected readonly sessions = computed(() =>
    (this.transactions.pending() ?? []).filter(
      (pending) => !this.only() || pending.session === this.only(),
    ),
  );

  protected time(at: number) {
    return new Date(at).toLocaleTimeString();
  }
  protected minutes(since: number) {
    return Math.max(0, Math.floor((this.transactions.now() - since) / 60_000));
  }
  protected limit(field: 'warnMinutes' | 'rollbackMinutes', text: string) {
    const minutes = Math.min(1440, Math.max(0, Math.round(Number(text) || 0)));
    void this.transactions.setLimits({ ...this.transactions.limits(), [field]: minutes });
  }
}
