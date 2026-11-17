import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VALUE } from '../../domain/db/edits';
import { GridCellEditor, GridEditing, editText } from './cell-editor';

function fixture(options: { reason?: string; active?: boolean } = {}) {
  const edits: [number, number, string][] = [];
  const pasted: string[][][] = [];
  let focused = 0;
  const input = document.createElement('input');
  document.body.append(input);
  const editing: GridEditing = {
    reason: () => options.reason ?? '',
    mark: () => undefined,
    edit: (row, column, text) => {
      edits.push([row, column, text]);
      return text === 'bad' ? 'db.edit.notInteger' : '';
    },
    paste: (_row, _column, block) => {
      pasted.push(block);
      return '';
    },
  };
  const editor = new GridCellEditor({
    editing: () => editing,
    active: () =>
      options.active === false
        ? undefined
        : { row: 1, column: 2, value: { $t: 'decimal', v: '1.5' } },
    focus: () => void focused++,
    input: () => input,
  });
  return { editor, edits, pasted, focused: () => focused, input };
}
const key = (key: string, extra: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key, cancelable: true, ...extra });

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
});

describe('the cell editor of a grid', () => {
  it('edits the text of a value, empty for NULL and a default', () => {
    expect(editText(null)).toBe('');
    expect(editText(DEFAULT_VALUE)).toBe('');
    expect(editText({ $t: 'integer', v: 5 })).toBe('5');
    expect(editText(true)).toBe('true');
  });

  it('starts with F2 or Enter from the value, or from the first key typed', () => {
    vi.useFakeTimers();
    const { editor, input } = fixture();
    expect(editor.key(key('F2'))).toBe(true);
    expect(editor.at()).toEqual({ row: 1, column: 2, text: '1.5', error: '' });
    expect(editor.editingAt(1, 2)).toBe(true);
    expect(editor.editingAt(0, 2)).toBe(false);
    vi.runAllTimers();
    expect(document.activeElement).toBe(input);
    expect(editor.key(key('7'))).toBe(true);
    expect(editor.at()?.text).toBe('1.57');
    expect(editor.key(key('Enter'))).toBe(false);
    editor.cancel();
    expect(editor.key(key('x'))).toBe(true);
    expect(editor.at()?.text).toBe('x');
    editor.cancel();
    expect(editor.key(key('Enter'))).toBe(true);
    editor.cancel();
    expect(editor.key(key('c', { ctrlKey: true }))).toBe(false);
    expect(editor.key(key('ArrowDown'))).toBe(false);
  });

  it('keeps a value that fits, and shows why one does not', () => {
    const { editor, edits, focused } = fixture();
    editor.commit('ignored');
    expect(edits).toEqual([]);
    editor.start();
    editor.commit('bad');
    expect(editor.at()).toMatchObject({ text: 'bad', error: 'db.edit.notInteger' });
    editor.commit('3');
    expect(editor.at()).toBeUndefined();
    expect(edits).toEqual([
      [1, 2, 'bad'],
      [1, 2, '3'],
    ]);
    expect(focused()).toBe(1);
  });

  it('edits nothing when the rows cannot be edited or nothing is active', () => {
    const locked = fixture({ reason: 'db.edit.readOnly' });
    expect(locked.editor.enabled()).toBe(false);
    expect(locked.editor.key(key('F2'))).toBe(false);
    locked.editor.start();
    expect(locked.editor.at()).toBeUndefined();
    const none = fixture({ active: false });
    none.editor.start();
    expect(none.editor.at()).toBeUndefined();
  });

  it('pastes the cells of the clipboard from the active one', async () => {
    const { editor, pasted } = fixture();
    expect(await editor.paste()).toBe('');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'a\tb\nc\td' },
    });
    expect(await editor.paste()).toBe('');
    expect(pasted).toEqual([
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ]);
    expect(await fixture({ reason: 'no' }).editor.paste()).toBe('');
  });
});
