import { ResultColumn } from '../../domain/db/results';
import { exportWriter } from '../../domain/db/transfer/export';
import { ExecutionPort, TransferSource, TransferTarget } from '../ports';
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
  async exportRows(
    job: ExportJob,
    file: TransferTarget,
    progress: (rows: number) => void,
    signal: AbortSignal,
  ): Promise<{ rows: number; cancelled: boolean }> {
    const statement = `export-${Date.now()}`;
    let rows: number;
    let cursor: string | undefined;
    try {
      const first = await this.api.execute<{
        columns: ResultColumn[];
        rows: unknown[][];
        cursor?: string | null;
      }>('db.execute', {
        workspace: job.workspace,
        session: job.session,
        statement,
        sql: job.sql,
        pageRows: TRANSFER_ROWS,
      });
      if (!first.columns.length) throw new Error('Only what a query reads can be exported');
      const ddl = await job.ddlFor?.(first.columns);
      const writer = exportWriter(
        job.format,
        { ...job.shape, columns: first.columns, ...(ddl ? { ddl } : {}) },
        job.options,
      );
      await file.write(writer.start() + writer.page(first.rows));
      rows = first.rows.length;
      cursor = first.cursor ?? undefined;
      progress(rows);
      while (cursor && !signal.aborted) {
        const page = await this.api.execute<{ rows: unknown[][]; cursor?: string | null }>(
          'db.fetch',
          { workspace: job.workspace, session: job.session, cursor, pageRows: TRANSFER_ROWS },
        );
        await file.write(writer.page(page.rows));
        rows += page.rows.length;
        cursor = page.cursor ?? undefined;
        progress(rows);
      }
      if (signal.aborted) {
        await file.discard();
        return { rows, cancelled: true };
      }
      await file.write(writer.end());
      await file.close();
      return { rows, cancelled: false };
    } catch (error) {
      await file.discard().catch(() => undefined);
      throw error;
    } finally {
      if (cursor)
        await this.api
          .execute('db.close', { workspace: job.workspace, session: job.session, cursor })
          .catch(() => undefined);
    }
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
