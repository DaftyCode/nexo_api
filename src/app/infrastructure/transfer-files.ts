import { invoke } from '@tauri-apps/api/core';
import { TransferFilesPort, TransferSource, TransferTarget } from '../application/ports';

/** A file chosen in the browser, read in slices. */
export function browserSource(file: File): TransferSource {
  return {
    name: file.name,
    size: file.size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    close: async () => undefined,
  };
}

/**
 * The web version: the file chosen in the browser, and an export kept in pieces that the
 * browser downloads when it ends.
 */
export class BrowserTransferFiles implements TransferFilesPort {
  open(extensions: readonly string[]): Promise<TransferSource | undefined> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = extensions.map((extension) => `.${extension}`).join(',');
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        resolve(file ? browserSource(file) : undefined);
      });
      input.addEventListener('cancel', () => resolve(undefined));
      input.click();
    });
  }
  async save(name: string, _extension: string, type: string): Promise<TransferTarget> {
    let parts: string[] = [];
    return {
      name,
      write: async (text) => void parts.push(text),
      close: async () => {
        const url = URL.createObjectURL(new Blob(parts, { type }));
        parts = [];
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      discard: async () => void (parts = []),
    };
  }
}

interface Chosen {
  handle: string;
  name: string;
  size: number;
}

/**
 * The desktop app: the system dialogs choose the file, and the app reads or writes it in
 * chunks through a handle. The interface never gets the path, nor the local service.
 */
export class DesktopTransferFiles implements TransferFilesPort {
  async open(extensions: readonly string[]): Promise<TransferSource | undefined> {
    const chosen = await invoke<Chosen | null>('transfer_open', { extensions: [...extensions] });
    if (!chosen) return undefined;
    return {
      name: chosen.name,
      size: chosen.size,
      read: async (offset, length) =>
        new Uint8Array(
          await invoke<ArrayBuffer>('transfer_read', { handle: chosen.handle, offset, length }),
        ),
      close: () => invoke('transfer_close', { handle: chosen.handle, discard: false }),
    };
  }
  async save(name: string, extension: string): Promise<TransferTarget | undefined> {
    const chosen = await invoke<Chosen | null>('transfer_save', { name, extension });
    if (!chosen) return undefined;
    return {
      name: chosen.name,
      write: (text) => invoke('transfer_write', { handle: chosen.handle, text }),
      close: () => invoke('transfer_close', { handle: chosen.handle, discard: false }),
      discard: () => invoke('transfer_close', { handle: chosen.handle, discard: true }),
    };
  }
}

/** The files of imports and exports for this build. */
export function transferFiles(): TransferFilesPort {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? new DesktopTransferFiles()
    : new BrowserTransferFiles();
}
