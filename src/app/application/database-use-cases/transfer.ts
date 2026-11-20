import { ExecutionPort, TransferSource, TransferTarget } from '../ports';
import { exportRows } from './transfer/export';
import { readFile } from './transfer/file';
import {
  CopyJob,
  ExportJob,
  ImportJob,
  TRANSFER_ROWS,
  TransferOutcome,
  WriteTarget,
  Written,
  add,
  emptyOutcome,
} from './transfer/types';

export * from './transfer/types';

/**
 * Transfers of data (DB-17): rows exported to a file a page at a time, a CSV or JSON file
 * imported in batches, and a query copied from one connection to another by the backend,
 * from driver to driver.
 */
export class DatabaseTransferCases {
  constructor(private readonly api: ExecutionPort) {}

  /** The `CREATE TABLE` of columns in a session's engine, and what each one became. */
  convert(
    workspace: string,
    session: string,
    table: string,
    columns: readonly { name: string; kind: string; typeName?: string; nullable?: boolean }[],
    options: { schema?: string; sourceDriver?: string; targetDriver?: string } = {},
  ) {
    return this.api.execute<{
      sql: string;
      columns: { name: string; from: string; type: string; asText: boolean }[];
    }>('db.convert', {
      workspace,
      session,
      table,
      columns,
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.sourceDriver ? { sourceDriver: options.sourceDriver } : {}),
      ...(options.targetDriver ? { targetDriver: options.targetDriver } : {}),
    });
  }

  /** Writes the rows of a query to a file; a cancelled export leaves no file. */
  exportRows(
    job: ExportJob,
    file: TransferTarget,
    progress: (rows: number) => void,
    signal: AbortSignal,
  ): Promise<{ rows: number; cancelled: boolean }> {
    return exportRows(this.api, job, file, progress, signal);
  }

  private run(target: WriteTarget, sql: string) {
    return this.api.execute('db.execute', {
      workspace: target.workspace,
      session: target.session,
      statement: `transfer-${Date.now()}`,
      sql,
      confirm: true,
    });
  }
  private transaction(target: WriteTarget, action: 'begin' | 'commit' | 'rollback') {
    return this.api.execute('db.transaction', {
      workspace: target.workspace,
      session: target.session,
      action,
    });
  }

  /**
   * What every transfer into a table does around its batches: the table created and
   * emptied first, and, stopping at the first failure, all of it as one transaction.
   */
  private async around(
    target: WriteTarget,
    clearSql: string,
    batches: (outcome: TransferOutcome) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    const outcome = emptyOutcome();
    if (target.create) await this.run(target, target.create);
    if (target.stopOnError) await this.transaction(target, 'begin');
    try {
      if (target.clear) await this.run(target, clearSql);
      await batches(outcome);
    } catch (error) {
      if (target.stopOnError) await this.transaction(target, 'rollback').catch(() => undefined);
      throw error;
    }
    outcome.cancelled = signal.aborted && !outcome.stopped;
    if (target.stopOnError)
      await this.transaction(target, outcome.stopped || outcome.cancelled ? 'rollback' : 'commit');
    return outcome;
  }

  private batch(target: WriteTarget, columns: readonly string[], rows: unknown[][], first: number) {
    return this.api.execute<Written>('db.import', {
      workspace: target.workspace,
      session: target.session,
      table: target.table,
      ...(target.schema ? { schema: target.schema } : {}),
      columns,
      rows,
      mode: target.mode,
      ...(target.key.length ? { key: target.key } : {}),
      stopOnError: target.stopOnError,
      first,
      ...(target.confirm ? { confirm: true } : {}),
    });
  }

  /** Imports a CSV or JSON file into a table, in batches. */
  importFile(
    job: ImportJob,
    clearSql: string,
    file: TransferSource,
    progress: (outcome: TransferOutcome, bytes: number) => void,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    const targets = job.columns.filter((column) => column.target).map((column) => column.target);
    return this.around(
      job,
      clearSql,
      async (outcome) => {
        await readFile(
          job,
          file,
          outcome,
          (rows, first) => this.batch(job, targets, rows, first),
          progress,
          signal,
        );
      },
      signal,
    );
  }

  /** Copies what a query of one session reads into a table of another, page by page. */
  copy(
    job: CopyJob,
    clearSql: string,
    progress: (outcome: TransferOutcome) => void,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    return this.around(
      job,
      clearSql,
      async (outcome) => {
        let cursor: string | undefined;
        // The pages after the first are written into the columns the first one named.
        let columns = job.columns;
        do {
          const page = await this.api.execute<
            Written & { read: number; cursor?: string | null; columns?: { name: string }[] }
          >('db.copy', {
            workspace: job.workspace,
            source: job.source,
            target: job.session,
            table: job.table,
            ...(job.schema ? { schema: job.schema } : {}),
            ...(cursor ? { cursor } : { sql: job.sql }),
            ...(columns ? { columns } : {}),
            mode: job.mode,
            ...(job.key.length ? { key: job.key } : {}),
            stopOnError: job.stopOnError,
            first: outcome.read + 1,
            pageRows: TRANSFER_ROWS,
            ...(job.confirm ? { confirm: true } : {}),
          });
          outcome.read += page.read;
          add(outcome, page);
          cursor = page.cursor ?? undefined;
          columns ??= page.columns?.map((column) => column.name);
          progress(outcome);
        } while (cursor && !outcome.stopped && !signal.aborted);
        if (cursor)
          await this.api
            .execute('db.close', { workspace: job.workspace, session: job.source, cursor })
            .catch(() => undefined);
      },
      signal,
    );
  }
}
