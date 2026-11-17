import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { DatabaseUseCases } from '../../application/database-use-cases';
import type { DbConnectionValue } from '../../domain/db/connection';
import type { ResultColumn } from '../../domain/db/results';
import type { WorkspaceDocument } from '../../domain/models';
import type { Toast } from '../workspace-state';
import { RowEditor } from './row-editor';
import type { DbSection } from './section';

const columns: ResultColumn[] = [
  {
    name: 'id',
    typeName: 'int4',
    kind: 'integer',
    key: true,
    origin: { schema: 'shop', table: 'orders', column: 'id' },
  },
  {
    name: 'total',
    typeName: 'int4',
    kind: 'integer',
    origin: { schema: 'shop', table: 'orders', column: 'total' },
  },
  {
    name: 'note',
    typeName: 'text',
    kind: 'text',
    origin: { schema: 'shop', table: 'orders', column: 'note' },
  },
];

function fixture(value: Partial<DbConnectionValue> = {}, options: { failing?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const toasts: Toast[] = [];
  const document = signal<WorkspaceDocument>({
    id: 'c1',
    workspace_id: 'w',
    kind: 'connection',
    name: 'Shop',
    revision: 1,
    updated_at: 0,
    value: { driver: 'postgres', ...value },
  });
  const cases = new DatabaseUseCases({
    execute: async (operation: string, payload: Record<string, unknown>) => {
      calls.push([operation, payload]);
      if (options.failing) throw new Error('write failed');
      return { affected: 2, statements: [] };
    },
    save: async (saved: WorkspaceDocument) => {
      document.set(saved);
      return saved;
    },
  } as never);
  let reloads = 0;
  const section = {
    connection: (id: string) => (id === 'c1' ? document() : undefined),
    sqlStyle: () => ({ name: 'postgresql', quoteOpen: '"', quoteClose: '"' }),
    cases: async () => cases,
    state: {
      workspaceId: () => 'w',
      tell: (toast: Toast) => void toasts.push(toast),
      describe: (error: unknown) => (error as Error).message,
      refresh: async () => undefined,
    },
  } as unknown as DbSection;
  const rows = signal<unknown[][]>([
    [1, 10, 'a'],
    [2, 20, null],
  ]);
  const editor = new RowEditor(section, {
    columns: () => columns,
    rows: () => rows(),
    connection: () => 'c1',
    session: () => 'editor:1',
    reload: async () => void reloads++,
  });
  return { editor, calls, toasts, document, rows, reloads: () => reloads };
}

describe('the row editor of a grid', () => {
  it('edits, pastes, sets NULL, adds, duplicates and deletes rows, undoable', () => {
    const { editor } = fixture();
    expect(editor.reason()).toBe('');
    expect(editor.edit(0, 1, 'x')).toBe('db.edit.notInteger');
    expect(editor.edit(0, 1, '11')).toBe('');
    expect(editor.edit(0, 9, '1')).toBe('db.virtual.readOnly');
    expect(editor.mark(0)).toBeDefined();
    expect(
      editor.paste(1, 1, [
        ['21', 'b'],
        ['99', 'c'],
      ]),
    ).toBe('');
    expect(editor.shown()[1]).toEqual([2, 21, 'b']);
    expect(editor.paste(0, 1, [['bad']])).toBe('db.edit.notInteger');
    editor.setValue([0, 1], 2, null);
    editor.setValue([0], 7, null);
    expect(editor.shown().map((row) => row[2])).toEqual([null, null]);
    editor.addRow();
    editor.duplicate([0]);
    expect(editor.shown()).toHaveLength(4);
    editor.remove([1, 3]);
    expect(editor.count()).toBe(3);
    editor.undo();
    expect(editor.count()).toBe(4);
    editor.discard();
    expect(editor.count()).toBe(0);
  });

  it('shows the script of a save with its values in line', () => {
    const { editor } = fixture();
    editor.edit(0, 2, 'changed');
    editor.remove([1]);
    editor.showScript();
    expect(editor.script()).toBe(
      "UPDATE shop.orders SET note = 'changed' WHERE id = 1;\nDELETE FROM shop.orders WHERE id = 2;",
    );
  });

  it('saves as one, says the rows written and reads them again', async () => {
    const { editor, calls, toasts, reloads } = fixture();
    await editor.save();
    expect(calls).toEqual([]);
    editor.optimistic.set(true);
    editor.edit(0, 2, 'changed');
    await editor.save();
    expect(calls[0]).toEqual([
      'db.rows.write',
      expect.objectContaining({
        schema: 'shop',
        table: 'orders',
        optimistic: true,
        session: 'editor:1',
      }),
    ]);
    expect(toasts[0]).toMatchObject({ title: 'db.edit.saved' });
    expect(editor.count()).toBe(0);
    expect(reloads()).toBe(1);
  });

  it('asks first on production, and does nothing when the person says no', async () => {
    const { editor, calls, toasts } = fixture({ type: 'production' });
    editor.edit(0, 2, 'changed');
    const saving = editor.save();
    await Promise.resolve();
    expect(editor.question()?.message).toBe('db.edit.confirmProduction');
    editor.question()!.answer(false);
    await saving;
    expect(calls).toEqual([]);
    const again = editor.save();
    await Promise.resolve();
    editor.question()!.answer(true);
    await again;
    expect(calls[0][1]).toMatchObject({ confirm: true });
    expect(toasts[0]).toMatchObject({ title: 'db.edit.savedPending' });
  });

  it('asks before deleting many rows, and says why a save failed', async () => {
    const { editor, rows, toasts } = fixture({}, { failing: true });
    rows.set(Array.from({ length: 101 }, (_, at) => [at, at, 'x']));
    editor.remove(Array.from({ length: 101 }, (_, at) => at));
    const saving = editor.save();
    await Promise.resolve();
    expect(editor.question()?.message).toBe('db.edit.confirmDeletes');
    editor.question()!.answer(true);
    await saving;
    expect(toasts[0]).toMatchObject({
      kind: 'error',
      title: 'db.edit.notSaved',
      detail: 'write failed',
    });
    expect(editor.count()).toBe(101);
  });

  it('refuses a read-only connection, and keeps virtual keys and columns', async () => {
    expect(fixture({ readOnly: true }).editor.reason()).toBe('db.edit.readOnly');
    const { editor, document } = fixture();
    await editor.setVirtualKey(['note']);
    expect((document().value as DbConnectionValue).virtualKeys).toEqual({
      'shop.orders': ['note'],
    });
    expect(editor.check().target?.key).toEqual([2]);
    await editor.setVirtualColumns([{ name: 'double', expression: 'total * 2' }]);
    expect(editor.grid().columns.map((column) => column.name)).toContain('double');
    expect(editor.grid().rows[0]).toEqual([1, 10, 'a', 20]);
    await editor.setVirtualColumns([]);
    expect((document().value as DbConnectionValue).virtualColumns).toEqual({});
  });
});
