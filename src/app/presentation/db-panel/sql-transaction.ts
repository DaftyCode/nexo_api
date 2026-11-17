import { readDbConnection } from '../../domain/db/connection';
import { Classification, Confirmation } from '../../domain/db/sql';
import type { SqlRunner } from './sql-runner';

/** Whether a transaction has something a rollback would undo. */
export function hasPendingWrites(state: { writes?: number } | undefined): boolean {
  return (state?.writes ?? 0) > 0;
}

/**
 * What the transaction asks before a statement runs, as DBeaver does:
 * - with smart commit, a statement that writes in auto-commit switches to manual commit first,
 *   so it can be rolled back;
 * - on an engine whose changes of structure commit what is pending (MySQL), such a change with
 *   writes pending is confirmed first;
 * - in manual commit, a chosen isolation level begins the transaction before its first
 *   statement.
 * `false`: the person did not confirm, and the statement does not run.
 */
export async function prepareTransaction(
  runner: SqlRunner,
  classification: Classification,
  confirm: (confirmation: Confirmation) => Promise<boolean>,
): Promise<boolean> {
  const connection = runner.connection();
  const writes = classification.kind === 'write' || classification.kind === 'structure';
  if (
    runner.transaction()?.autoCommit &&
    writes &&
    readDbConnection(connection?.value).smartCommit
  ) {
    await runner.transact('manual');
    runner.results.note({ kind: 'info', text: 'db.smartCommit.switched' });
  }
  const state = runner.transaction();
  if (!state || state.autoCommit) return true;
  const capabilities = runner.section.drivers.capabilities(connection?.id ?? '');
  if (classification.kind === 'structure' && capabilities?.ddlCommits && hasPendingWrites(state))
    return confirm({
      message: 'db.confirm.ddlCommits',
      params: { v0: String(state.writes ?? 0) },
    });
  if (!state.open && runner.isolation() && classification.kind !== 'transaction')
    await runner.transact('begin');
  return true;
}
