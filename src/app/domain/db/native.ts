/**
 * Backups, restores and scripts with the local client tools of a connection's engine
 * (DB-23, desktop only): the options of each, as the backend reads them, the format of a
 * file, and whether the tools found are older than the server.
 */

export type NativeAction = 'backup' | 'restore' | 'script';
export type BackupFormat = 'plain' | 'custom' | 'directory' | 'tar';
export const BACKUP_FORMATS: readonly BackupFormat[] = ['plain', 'custom', 'directory', 'tar'];
export type BackupContent = 'all' | 'schema' | 'data';
export const BACKUP_CONTENTS: readonly BackupContent[] = ['all', 'schema', 'data'];

/** The engines whose tools Nexo runs: PostgreSQL, and MySQL and MariaDB (one driver). */
export function hasNativeTools(driver: string): boolean {
  return driver === 'postgres' || driver === 'mysql';
}

export interface NativeForm {
  /** PostgreSQL: every database of the server (`pg_dumpall`). */
  server: boolean;
  format: BackupFormat;
  content: BackupContent;
  /** Names separated by commas. */
  schemas: string;
  /** Names separated by commas, `schema.table` in PostgreSQL. */
  tables: string;
  noOwner: boolean;
  noPrivileges: boolean;
  inserts: boolean;
  /** `''` or a level from 0 to 9. */
  compress: string;
  /** The database a restore or script goes to; the connection's when empty. */
  database: string;
  clean: boolean;
  dataOnly: boolean;
  singleTransaction: boolean;
  stopOnError: boolean;
  /** The longest the run may last, in minutes; none when empty. */
  minutes: string;
  /** A restore: the name of its database, typed to confirm it. */
  confirmName: string;
}

export function emptyNativeForm(): NativeForm {
  return {
    server: false,
    format: 'plain',
    content: 'all',
    schemas: '',
    tables: '',
    noOwner: false,
    noPrivileges: false,
    inserts: false,
    compress: '',
    database: '',
    clean: false,
    dataOnly: false,
    singleTransaction: true,
    stopOnError: true,
    minutes: '',
    confirmName: '',
  };
}

const list = (text: string) =>
  text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

/** A table as the backend reads it: its name, or its schema and name. */
function table(name: string, postgres: boolean): string | { schema: string; name: string } {
  const dot = name.indexOf('.');
  return postgres && dot > 0 ? { schema: name.slice(0, dot), name: name.slice(dot + 1) } : name;
}

/** The options of a run, for `path`. */
export function nativeOptions(
  action: NativeAction,
  form: NativeForm,
  path: string,
  driver: string,
): Record<string, unknown> {
  const postgres = driver === 'postgres';
  if (action === 'script') return { path, stopOnError: form.stopOnError };
  if (action === 'restore') {
    const plain = form.format === 'plain' || !postgres;
    return {
      path,
      format: postgres ? form.format : 'plain',
      singleTransaction: postgres && form.singleTransaction,
      ...(plain
        ? {}
        : {
            clean: form.clean,
            dataOnly: form.dataOnly,
            noOwner: form.noOwner,
            noPrivileges: form.noPrivileges,
          }),
    };
  }
  const server = postgres && form.server;
  return {
    path,
    server,
    format: postgres && !server ? form.format : 'plain',
    content: form.content,
    schemas: postgres && !server ? list(form.schemas) : [],
    tables: server ? [] : list(form.tables).map((name) => table(name, postgres)),
    noOwner: postgres && form.noOwner,
    noPrivileges: postgres && form.noPrivileges,
    inserts: form.inserts,
    ...(postgres && form.compress !== '' && form.format !== 'tar' && !server
      ? { compress: Number(form.compress) }
      : {}),
  };
}

/** The time limit of a run, in seconds, when one is set. */
export function nativeTimeout(form: NativeForm): number | undefined {
  const minutes = Number(form.minutes);
  return form.minutes.trim() && minutes > 0 ? Math.round(minutes * 60) : undefined;
}

/** How a file was most likely written, by its extension: `.sql` is plain SQL. */
export function formatOfFile(path: string): BackupFormat {
  const name = path.toLowerCase();
  if (name.endsWith('.tar')) return 'tar';
  if (name.endsWith('.dump') || name.endsWith('.backup')) return 'custom';
  return 'plain';
}

/** The name proposed for a backup file. */
export function backupFileName(database: string, format: BackupFormat): string {
  const base = (database || 'backup').replace(/[^\w.-]+/g, '_');
  return `${base}.${format === 'plain' ? 'sql' : format === 'tar' ? 'tar' : 'dump'}`;
}

/** The first number of a version (`pg_dump (PostgreSQL) 16.4` is 16). */
function major(version: string): number | undefined {
  const found = /(\d+)(?:\.\d+)?/.exec(version);
  return found ? Number(found[1]) : undefined;
}

/** Whether the tools found are older than the server, which they may not read. */
export function olderThanServer(tool: string, server: string | undefined): boolean {
  const [a, b] = [major(tool), server ? major(server) : undefined];
  return a !== undefined && b !== undefined && a < b;
}

/** How a run goes, as the backend says it. */
export interface NativeRun {
  tool: string;
  state: 'running' | 'finished' | 'failed' | 'cancelled';
  lines: string[];
  dropped: number;
  exitCode?: number | null;
  seconds: number;
}

export function readNativeRun(value: unknown): NativeRun {
  const run = (value ?? {}) as Partial<NativeRun>;
  const state = ['running', 'finished', 'failed', 'cancelled'].includes(String(run.state))
    ? (run.state as NativeRun['state'])
    : 'failed';
  return {
    tool: String(run.tool ?? ''),
    state,
    lines: Array.isArray(run.lines) ? run.lines.map(String) : [],
    dropped: Number(run.dropped ?? 0),
    exitCode: run.exitCode ?? null,
    seconds: Number(run.seconds ?? 0),
  };
}
