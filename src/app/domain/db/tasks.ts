/**
 * Saved database tasks (`db-task` documents, DB-31): SQL scripts on some connections, a copy
 * of a query into a table of another connection, a comparison of two schemas or tables, a
 * backup with the local client, or other tasks in order. What a task authorizes when nobody is
 * there to confirm is ticked by the person and shown with a warning; a schedule runs it while
 * Nexo is open. The application runs it (`db.task.run`) and keeps its last runs.
 */
import type { WorkspaceDocument } from '../models';
import {
  TRANSFER_TASK_TYPES,
  TransferFields,
  TransferTaskType,
  cronProblem,
  emptyTransferFields,
  readTransferFields,
  transferProblem,
  transferValue,
} from './tasks/transfer';

export type TaskType = 'script' | 'copy' | 'compare' | 'backup' | 'composite' | TransferTaskType;
export const TASK_TYPES: readonly TaskType[] = [
  'script',
  'copy',
  'compare',
  'backup',
  'composite',
  ...TRANSFER_TASK_TYPES,
];
export type Authorization = 'writes' | 'everyRow' | 'drop';
export const AUTHORIZATIONS: readonly Authorization[] = ['writes', 'everyRow', 'drop'];

/** What the form edits of a task: every field of every type, the ones of its type used. */
export interface TaskForm extends TransferFields {
  name: string;
  folder: string;
  type: TaskType;
  scripts: string[];
  connections: string[];
  onError: 'stop' | 'continue';
  transaction: boolean;
  source: string;
  target: string;
  sql: string;
  table: string;
  schema: string;
  mode: 'schema' | 'data';
  sourcePath: string;
  targetPath: string;
  connection: string;
  file: string;
  tasks: string[];
  authorize: Record<Authorization, boolean>;
  /** Minutes between runs; 0 runs it only by hand, or on `cron` when it has one. */
  every: number;
  /** A cron expression of five fields (`0 9 * * mon-fri`); empty for none. */
  cron: string;
  paused: boolean;
}

/** A run of a task, as its history keeps it. */
export interface TaskRun {
  startedAt: number;
  duration: number;
  trigger: string;
  state: 'passed' | 'failed' | 'differences' | 'skipped';
  statements: number;
  rows: number;
  differences?: number;
  error?: string;
  statement?: string;
}

export function emptyTaskForm(): TaskForm {
  return {
    name: '',
    folder: '',
    type: 'script',
    scripts: [],
    connections: [],
    onError: 'stop',
    transaction: false,
    source: '',
    target: '',
    sql: '',
    table: '',
    schema: '',
    mode: 'schema',
    sourcePath: '',
    targetPath: '',
    connection: '',
    file: '',
    tasks: [],
    authorize: { writes: false, everyRow: false, drop: false },
    every: 0,
    cron: '',
    paused: false,
    ...emptyTransferFields(),
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const texts = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
/** A path of the tree written as `a/b/c`, and back. */
const pathText = (value: unknown) => texts(value).join('/');
const pathOf = (text: string) =>
  text
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

/** The form of a saved task. */
export function taskForm(document: WorkspaceDocument): TaskForm {
  const value = record(document.value);
  const source = record(value['source']);
  const target = record(value['target']);
  const authorize = record(value['authorize']);
  const schedule = record(value['schedule']);
  const every = Number(schedule['every']) || 0;
  const type = TASK_TYPES.find((each) => each === value['type']) ?? 'script';
  return {
    ...emptyTaskForm(),
    name: document.name,
    folder: text(value['folder']),
    type,
    scripts: texts(value['scripts']),
    connections: texts(value['connections']),
    onError: value['onError'] === 'continue' ? 'continue' : 'stop',
    transaction: value['transaction'] === true,
    source: type === 'compare' ? text(source['connection']) : text(value['source']),
    target: type === 'compare' ? text(target['connection']) : text(value['target']),
    sql: text(value['sql']),
    table: text(value['table']),
    schema: text(value['schema']),
    mode: value['mode'] === 'data' ? 'data' : 'schema',
    sourcePath: pathText(source['path']),
    targetPath: pathText(target['path']),
    connection: text(value['connection']),
    file: text(value['file']),
    tasks: texts(value['tasks']),
    authorize: {
      writes: authorize['writes'] === true,
      everyRow: authorize['everyRow'] === true,
      drop: authorize['drop'] === true,
    },
    every: schedule['unit'] === 'hours' ? every * 60 : every,
    cron: text(schedule['cron']),
    paused: value['paused'] === true,
    ...readTransferFields(value),
  };
}

/** What keeps a task from being saved, as a message; empty when nothing. */
export function taskProblem(form: TaskForm): string {
  if (!form.name.trim()) return 'Give the task a name';
  switch (form.type) {
    case 'script':
      if (!form.scripts.length) return 'Choose the scripts the task runs';
      if (!form.connections.length) return 'Choose the connections the scripts run on';
      break;
    case 'copy':
      if (!form.source || !form.target)
        return 'A copy names the connection it reads and the one it writes';
      if (!form.sql.trim() || !form.table.trim())
        return 'A copy names the query it reads and the table it writes';
      break;
    case 'compare':
      if (!form.source || !form.target || !form.sourcePath.trim() || !form.targetPath.trim())
        return 'Each side of a comparison names its connection and its object';
      break;
    case 'backup':
      if (!form.connection || !form.file.trim())
        return 'A backup names its connection and the file it writes';
      break;
    case 'composite':
      if (!form.tasks.length) return 'Choose the tasks it runs, in order';
      break;
    default: {
      const problem = transferProblem(form.type, form);
      if (problem) return problem;
    }
  }
  if (form.cron.trim()) return cronProblem(form.cron);
  if (form.every && ![1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].includes(form.every))
    return 'db.task.every';
  return '';
}

/** The minutes and hours a task may run every, as the monitors'. */
export const TASK_EVERY: readonly number[] = [0, 1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/** The value stored for a task: only the fields of its type. */
export function taskValue(form: TaskForm): Json {
  const authorize = Object.fromEntries(
    AUTHORIZATIONS.filter((key) => form.authorize[key]).map((key) => [key, true]),
  );
  const schedule = form.cron.trim()
    ? { cron: form.cron.trim() }
    : form.every >= 60 && form.every % 60 === 0
      ? { every: form.every / 60, unit: 'hours' }
      : form.every
        ? { every: form.every, unit: 'minutes' }
        : null;
  const common = {
    type: form.type,
    ...(form.folder.trim() ? { folder: form.folder.trim() } : {}),
    ...(Object.keys(authorize).length ? { authorize } : {}),
    ...(schedule ? { schedule } : {}),
    ...(form.paused ? { paused: true } : {}),
  };
  switch (form.type) {
    case 'script':
      return {
        ...common,
        scripts: form.scripts,
        connections: form.connections,
        onError: form.onError,
        transaction: form.transaction,
      };
    case 'copy':
      return {
        ...common,
        source: form.source,
        target: form.target,
        sql: form.sql.trim(),
        table: form.table.trim(),
        ...(form.schema.trim() ? { schema: form.schema.trim() } : {}),
      };
    case 'compare': {
      const side = (connection: string, path: string) => {
        const parts = pathOf(path);
        return form.mode === 'data'
          ? { connection, path: parts, table: parts.at(-1) ?? '' }
          : { connection, path: parts };
      };
      return {
        ...common,
        mode: form.mode,
        source: side(form.source, form.sourcePath),
        target: side(form.target, form.targetPath),
      };
    }
    case 'backup':
      return { ...common, connection: form.connection, file: form.file.trim(), options: {} };
    case 'composite':
      return { ...common, tasks: form.tasks, onError: form.onError };
    default:
      return { ...common, ...transferValue(form.type, form) };
  }
}

/** The runs of a task, newest first, from the value of its history (`<task>~history`). */
export function readTaskRuns(value: unknown): TaskRun[] {
  const runs = record(value)['runs'];
  return Array.isArray(runs) ? runs.filter((run) => record(run)['startedAt'] !== undefined) : [];
}

/** Whether a task authorizes anything: the list shows a warning. */
export const authorizes = (document: WorkspaceDocument) =>
  Object.values(record(record(document.value)['authorize'])).some((flag) => flag === true);
