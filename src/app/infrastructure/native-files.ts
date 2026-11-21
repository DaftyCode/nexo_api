import { invoke } from '@tauri-apps/api/core';
import { NativeFilesPort } from '../application/ports';

/** The web version: no page may run programs of the computer or read its paths. */
export class BrowserNativeFiles implements NativeFilesPort {
  readonly available = false;
  async choose(): Promise<string | undefined> {
    return undefined;
  }
}

/** The desktop app: the system dialogs choose the files and folders and give their paths. */
export class DesktopNativeFiles implements NativeFilesPort {
  readonly available = true;
  async choose(purpose: 'folder' | 'save' | 'open', name?: string): Promise<string | undefined> {
    return (await invoke<string | null>('native_choose', { purpose, name })) ?? undefined;
  }
}

/** The dialogs of the local client tools for this build. */
export function nativeFiles(): NativeFilesPort {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? new DesktopNativeFiles()
    : new BrowserNativeFiles();
}
