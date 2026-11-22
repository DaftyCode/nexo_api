/**
 * The tasks with files and MongoDB of DB-40: a query written to a file, a file written into a
 * table, a saved MongoDB transfer and a saved MongoDB comparison. Their fields in the form,
 * the value stored for each one, and what keeps them from being saved.
 */
export type FileFormat = 'csv' | 'json' | 'jsonl';
export const FILE_FORMATS: readonly FileFormat[] = ['csv', 'json', 'jsonl'];
export type TransferTaskType = 'export' | 'import' | 'mongo-transfer' | 'mongo-compare';
export const TRANSFER_TASK_TYPES: readonly TransferTaskType[] = [
  'export',
  'import',
  'mongo-transfer',
  'mongo-compare',
];

/** The fields of the form these tasks use; the connection, query, table and file are shared. */
export interface TransferFields {
  format: FileFormat;
  overwrite: boolean;
  /** CSV: the separator and whether the first line names the columns. */
  separator: string;
  header: boolean;
  importMode: 'insert' | 'upsert';
  /** Upsert: the columns of the key, with commas. */
  key: string;
  /** The saved MongoDB transfer or comparison it runs. */
  transfer: string;
  comparison: string;
  /** Makes the target like the source when they differ. */
  sync: boolean;
}

export function emptyTransferFields(): TransferFields {
  return {
    format: 'csv',
    overwrite: false,
    separator: ',',
    header: true,
    importMode: 'insert',
    key: '',
    transfer: '',
    comparison: '',
    sync: false,
  };
}

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (text: string) =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The fields of a stored value. */
export function readTransferFields(value: Json): TransferFields {
  const format = FILE_FORMATS.find((each) => each === value['format']) ?? 'csv';
  return {
    format,
    overwrite: value['overwrite'] === true,
    separator: text(value['separator']) || ',',
    header: value['header'] !== false,
    importMode: value['mode'] === 'upsert' ? 'upsert' : 'insert',
    key: Array.isArray(value['key']) ? (value['key'] as unknown[]).map(text).join(', ') : '',
    transfer: text(value['transfer']),
    comparison: text(value['comparison']),
    sync: value['sync'] === true,
  };
}

/** What a form of these tasks shares with the others. */
export interface SharedFields {
  connection: string;
  sql: string;
  table: string;
  schema: string;
  file: string;
}

/** The value stored for one of these tasks: only the fields of its type. */
export function transferValue(type: TransferTaskType, form: TransferFields & SharedFields): Json {
  const file = form.file.trim();
  const csv =
    form.format === 'csv'
      ? {
          ...(form.separator && form.separator !== ',' ? { separator: form.separator } : {}),
          ...(form.header ? {} : { header: false }),
        }
      : {};
  switch (type) {
    case 'export':
      return {
        connection: form.connection,
        sql: form.sql.trim(),
        format: form.format,
        file,
        ...(form.overwrite ? { overwrite: true } : {}),
        ...csv,
      };
    case 'import':
      return {
        connection: form.connection,
        file,
        format: form.format,
        table: form.table.trim(),
        ...(form.schema.trim() ? { schema: form.schema.trim() } : {}),
        mode: form.importMode,
        ...(form.importMode === 'upsert' ? { key: list(form.key) } : {}),
        ...(form.format === 'csv' && form.separator !== ',' ? { separator: form.separator } : {}),
      };
    case 'mongo-transfer':
      return {
        transfer: form.transfer,
        ...(file ? { file } : {}),
        ...(form.overwrite ? { overwrite: true } : {}),
      };
    case 'mongo-compare':
      return { comparison: form.comparison, ...(form.sync ? { sync: true } : {}) };
  }
}

/** What keeps one of these tasks from being saved, as a message; empty when nothing. */
export function transferProblem(type: TransferTaskType, form: TransferFields & SharedFields) {
  switch (type) {
    case 'export':
    case 'import':
      if (!form.connection || !form.file.trim())
        return 'A transfer names its connection and its file';
      if (type === 'export' && !form.sql.trim()) return 'An export names the query it writes';
      if (type === 'import' && !form.table.trim()) return 'An import names the table it writes';
      if (type === 'import' && form.importMode === 'upsert' && !list(form.key).length)
        return 'An upsert names the columns of its key';
      return '';
    case 'mongo-transfer':
      return form.transfer ? '' : 'Choose the saved MongoDB transfer the task runs';
    case 'mongo-compare':
      return form.comparison ? '' : 'Choose the saved MongoDB comparison the task runs';
  }
}

/** A cron expression of five fields, as the scheduler reads it; empty when none. */
export function cronProblem(cron: string): string {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 ? '' : 'db.task.cron';
}
