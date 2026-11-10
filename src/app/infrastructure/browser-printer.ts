import { Injectable } from '@angular/core';
import { PrintPort } from '../application/ports';

/**
 * Prints a report through the browser's print dialog, where "Save as PDF" is one of the
 * printers. A copy of the report is the only thing printed: the rest of the page is hidden
 * while it is there. In the desktop app the webview prints itself (`print_page` in
 * `src-tauri`), since `window.print()` does nothing in some system webviews.
 */
@Injectable()
export class BrowserPrinter implements PrintPort {
  private sheet: HTMLElement | undefined;

  async print(content: HTMLElement) {
    this.release();
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.appendChild(content.cloneNode(true));
    document.body.appendChild(sheet);
    document.body.classList.add('printing');
    this.sheet = sheet;
    window.addEventListener('afterprint', () => this.release(), { once: true });
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('print_page');
    } else {
      window.print();
    }
  }
  release() {
    this.sheet?.remove();
    this.sheet = undefined;
    document.body.classList.remove('printing');
  }
}
