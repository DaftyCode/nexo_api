import {
  JsonRecord,
  Table,
  TableFormat,
  csvText,
  flatten,
  runRecords,
} from '../../domain/export/table';
import { XLSX_TYPE, xlsx } from '../../domain/export/xlsx';
import { RunReport } from '../../domain/reports';
import { MaskingCases } from './masking';

/** How a table is exported: the format, the CSV separator and a masking set (or none). */
export interface TableExportOptions {
  format: TableFormat;
  separator: string;
  /** The id of a masking set; `''` exports the values as they are. */
  set: string;
}

/** A file ready to save. `cut` says some rows, columns or long texts did not fit. */
export interface ExportedFile {
  name: string;
  type: string;
  data: string | Uint8Array;
  rows: number;
  cut: boolean;
}

/** A name a file can have on every system. */
export function fileName(name: string, fallback: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .trim()
      .slice(0, 120) || fallback
  );
}

/**
 * CSV and Excel files of tables (B-06): the requests of a run and the records of a JSON
 * response, masked first by a set when one is chosen. Masking works on the records, so a
 * rule can name an embedded field (`customer.email`) before it becomes a column.
 */
export class TableExportCases {
  constructor(private readonly masking: MaskingCases) {}

  /** A collection run: one row per request and iteration. */
  run(workspace: string, report: RunReport, options: TableExportOptions) {
    return this.records(
      workspace,
      runRecords(report),
      fileName(report.collection, 'collection-run'),
      options,
    );
  }

  /** Records as a table, one column per field, masked first when asked. */
  async records(
    workspace: string,
    records: readonly JsonRecord[],
    name: string,
    options: TableExportOptions,
  ): Promise<ExportedFile> {
    const masked = options.set
      ? await this.masking.documents(workspace, options.set, records)
      : records;
    const table = flatten(masked);
    const file = this.file(name, table, options);
    return { ...file, cut: file.cut || table.cut };
  }

  /** The file of a table in the format asked. */
  file(name: string, table: Table, options: TableExportOptions): ExportedFile {
    const base = fileName(name, 'export');
    if (options.format === 'xlsx') {
      const { bytes, cut } = xlsx(base, table.columns, table.rows);
      return { name: `${base}.xlsx`, type: XLSX_TYPE, data: bytes, rows: table.rows.length, cut };
    }
    return {
      name: `${base}.csv`,
      type: 'text/csv;charset=utf-8',
      data: csvText(table, options.separator),
      rows: table.rows.length,
      cut: false,
    };
  }
}
