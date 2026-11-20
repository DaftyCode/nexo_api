import { ResultColumn } from '../../../domain/db/results';
import { exportWriter } from '../../../domain/db/transfer/export';
import { XlsxSheet, workbook } from '../../../domain/export/xlsx';
import { ExecutionPort, TransferTarget } from '../../ports';
import { ExportJob, TRANSFER_ROWS } from './types';

interface Page {
  rows: unknown[][];
  cursor?: string | null;
}

/** Where the pages go: text written as it comes, or a workbook written at the end. */
interface Output {
  page(rows: unknown[][]): Promise<void>;
  end(): Promise<void>;
}

/**
 * Writes the rows of a query to a file, a page at a time; a cancelled export leaves no
 * file. With a masking set, each page is masked first: the columns a rule removes are left
 * out of the file, and the rest keep their order.
 */
export async function exportRows(
  api: ExecutionPort,
  job: ExportJob,
  file: TransferTarget,
  progress: (rows: number) => void,
  signal: AbortSignal,
): Promise<{ rows: number; cancelled: boolean }> {
  const statement = `export-${Date.now()}`;
  let rows: number;
  let cursor: string | undefined;
  try {
    const first = await api.execute<Page & { columns: ResultColumn[] }>('db.execute', {
      workspace: job.workspace,
      session: job.session,
      statement,
      sql: job.sql,
      pageRows: TRANSFER_ROWS,
    });
    if (!first.columns.length) throw new Error('Only what a query reads can be exported');
    let columns = first.columns;
    const names = first.columns.map((column) => column.name);
    const masked = async (page: unknown[][]) => {
      if (!job.mask) return page;
      const answer = await api.execute<{ kept: number[]; rows: unknown[][] }>('mask.apply', {
        workspace: job.workspace,
        set: job.mask,
        columns: names,
        rows: page,
      });
      columns = answer.kept.map((at) => first.columns[at]);
      return answer.rows;
    };
    const firstRows = await masked(first.rows);
    const output = await open(job, columns, file);
    await output.page(firstRows);
    rows = first.rows.length;
    cursor = first.cursor ?? undefined;
    progress(rows);
    while (cursor && !signal.aborted) {
      const page = await api.execute<Page>('db.fetch', {
        workspace: job.workspace,
        session: job.session,
        cursor,
        pageRows: TRANSFER_ROWS,
      });
      await output.page(await masked(page.rows));
      rows += page.rows.length;
      cursor = page.cursor ?? undefined;
      progress(rows);
    }
    if (signal.aborted) {
      await file.discard();
      return { rows, cancelled: true };
    }
    await output.end();
    await file.close();
    return { rows, cancelled: false };
  } catch (error) {
    await file.discard().catch(() => undefined);
    throw error;
  } finally {
    if (cursor)
      await api
        .execute('db.close', { workspace: job.workspace, session: job.session, cursor })
        .catch(() => undefined);
  }
}

/** The output of the job's format, its start already written. */
async function open(
  job: ExportJob,
  columns: ResultColumn[],
  file: TransferTarget,
): Promise<Output> {
  if (job.format === 'xlsx') {
    const name = job.shape.table.replace(/["`]/g, '') || 'Export';
    const sheet = new XlsxSheet(
      name,
      columns.map((column) => column.name),
    );
    return {
      page: async (rows) => sheet.add(rows),
      end: () => file.writeBytes(workbook([sheet])),
    };
  }
  const ddl = await job.ddlFor?.(columns);
  const writer = exportWriter(
    job.format,
    { ...job.shape, columns, ...(ddl ? { ddl } : {}) },
    job.options,
  );
  await file.write(writer.start());
  return {
    page: (rows) => file.write(writer.page(rows)),
    end: () => file.write(writer.end()),
  };
}
