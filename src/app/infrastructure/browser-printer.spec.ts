import { vi } from 'vitest';
import { BrowserPrinter } from './browser-printer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

describe('BrowserPrinter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('prints only a copy of the report, and removes it after printing', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const printer = new BrowserPrinter();
    const report = document.createElement('article');
    report.textContent = 'Run report';
    await printer.print(report);
    expect(print).toHaveBeenCalledOnce();
    const sheet = document.body.querySelector('.print-sheet');
    expect(sheet?.textContent).toBe('Run report');
    expect(sheet?.firstChild).not.toBe(report);
    expect(document.body.classList.contains('printing')).toBe(true);

    // Printing again replaces the copy; the dialog closing removes it.
    await printer.print(report);
    expect(document.body.querySelectorAll('.print-sheet')).toHaveLength(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.querySelector('.print-sheet')).toBeNull();
    expect(document.body.classList.contains('printing')).toBe(false);
  });

  it('asks the desktop webview to print itself', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const { invoke } = await import('@tauri-apps/api/core');
    const printer = new BrowserPrinter();
    await printer.print(document.createElement('div'));
    expect(invoke).toHaveBeenCalledWith('print_page');
    expect(print).not.toHaveBeenCalled();
    printer.release();
    expect(document.body.querySelector('.print-sheet')).toBeNull();
  });
});
