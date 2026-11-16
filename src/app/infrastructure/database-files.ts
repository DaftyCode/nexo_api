import { invoke } from '@tauri-apps/api/core';
import { DatabaseFilesPort } from '../application/ports';

/** The web version: the path is typed, as no page may read the computer's paths. */
export class BrowserDatabaseFiles implements DatabaseFilesPort {
  readonly available = false;
  async choose(): Promise<string | undefined> {
    return undefined;
  }
}

/** The desktop app: the system dialog chooses the file and gives its path. */
export class DesktopDatabaseFiles implements DatabaseFilesPort {
  readonly available = true;
  async choose(create: boolean): Promise<string | undefined> {
    return (await invoke<string | null>('db_file_choose', { create })) ?? undefined;
  }
}

/** The files of databases for this build. */
export function databaseFiles(): DatabaseFilesPort {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? new DesktopDatabaseFiles()
    : new BrowserDatabaseFiles();
}
