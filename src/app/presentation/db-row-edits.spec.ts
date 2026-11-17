import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VALUE } from '../domain/db/edits';
import type { RowEditor } from './db-panel/row-editor';
import { editAction } from './db-row-edits';

function editor() {
  const done: [string, ...unknown[]][] = [];
  const fake = {
    addRow: () => void done.push(['add']),
    duplicate: (rows: number[]) => void done.push(['duplicate', rows]),
    remove: (rows: number[]) => void done.push(['remove', rows]),
    setValue: (rows: number[], column: number, value: unknown) =>
      void done.push(['set', rows, column, value]),
  } as unknown as RowEditor;
  return { fake, done };
}

afterEach(() => vi.restoreAllMocks());

describe('the edit actions of a grid', () => {
  it('adds, duplicates, deletes and sets NULL or the default on the rows chosen', () => {
    const { fake, done } = editor();
    editAction(fake, { action: 'edit.add', column: 0, rows: [] });
    editAction(fake, { action: 'edit.duplicate', column: 0, rows: [1] });
    editAction(fake, { action: 'edit.delete', column: 0, rows: [2] });
    editAction(fake, { action: 'edit.null', column: 1, rows: [3] });
    editAction(fake, { action: 'edit.default', column: 2, rows: [] });
    editAction(fake, { action: 'edit.other', column: 2, rows: [] });
    expect(done).toEqual([
      ['add'],
      ['duplicate', [1]],
      ['remove', [2]],
      ['set', [3], 1, null],
      ['set', [], 2, DEFAULT_VALUE],
    ]);
  });

  it('loads a file chosen into a cell as a binary, and nothing when none is chosen', async () => {
    const { fake, done } = editor();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { value: [new File(['ab'], 'a.bin')] });
      this.dispatchEvent(new Event('change'));
    });
    editAction(fake, { action: 'edit.file', column: 4, rows: [0] });
    for (let i = 0; i < 20 && !done.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toEqual([['set', [0], 4, { $t: 'binary', v: 'YWI=' }]]);

    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { value: [] });
      this.dispatchEvent(new Event('change'));
    });
    editAction(fake, { action: 'edit.file', column: 4, rows: [0] });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      this.dispatchEvent(new Event('cancel'));
    });
    editAction(fake, { action: 'edit.file', column: 4, rows: [0] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toHaveLength(1);
  });
});
