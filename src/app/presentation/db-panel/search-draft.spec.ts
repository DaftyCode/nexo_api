import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DatabaseUseCases } from '../../application/database-use-cases';
import { SearchDraft } from './search-draft';
import type { DbSection } from './section';

function fixture(
  options: {
    active?: string;
    installed?: boolean;
    search?: (payload: Record<string, unknown>) => unknown;
  } = {},
) {
  const asked: [string, Record<string, unknown>][] = [];
  const cases = new DatabaseUseCases({
    execute: async (operation: string, payload: Record<string, unknown>) => {
      asked.push([operation, payload]);
      if (operation === 'db.search') return options.search?.(payload) ?? {};
      if (operation === 'db.close' || operation === 'db.cancel') throw new Error('gone');
      return { serverVersion: '1', tls: false };
    },
  } as never);
  const documents = [{ id: 'c1', name: 'Shop', kind: 'connection', value: { driver: 'postgres' } }];
  const section = {
    active: signal(options.active ?? ''),
    cases: async () => cases,
    connection: (id: string) => documents.find((document) => document.id === id),
    ensure: async () => options.installed !== false,
    state: {
      workspaceId: () => 'w',
      scopes: () => ({ environment: [], collection: [], globals: [] }),
      describe: (error: unknown) => (error as Error).message,
    },
  } as unknown as DbSection;
  const draft = new SearchDraft(section, TestBed.inject(Injector));
  return { draft, asked };
}

describe('the search dialog, at its edges', () => {
  it('starts without a connection when none is chosen, and says why one cannot be searched', async () => {
    const { draft } = fixture();
    expect(draft.connections().size).toBe(0);
    draft.toggle('connections', 'gone');
    draft.model.update((model) => ({ ...model, text: 'x' }));
    await draft.findObjects();
    expect(draft.objects()[0]).toMatchObject({
      connection: 'gone',
      error: 'The connection is no longer there',
    });

    const missing = fixture({ active: 'c1', installed: false });
    missing.draft.model.update((model) => ({ ...model, text: 'x' }));
    await missing.draft.findObjects();
    expect(missing.draft.objects()[0].error).toBe('The module of the connection is not installed');
  });

  it('takes answers without objects or data as empty', async () => {
    const { draft } = fixture({ active: 'c1', search: () => ({}) });
    draft.model.update((model) => ({ ...model, text: 'x', connection: 'c1', texts: false }));
    await draft.findObjects();
    expect(draft.objects()[0]).toMatchObject({ hits: [], more: false });
    await draft.findTables();
    expect(draft.tables()).toEqual([]);
    draft.tables.set([{ name: 't', path: ['t'], chosen: true }]);
    await draft.findData();
    expect(draft.data()).toEqual([]);
    await draft.close();
  });

  it('stops between tables when cancelled, and says why a search failed', async () => {
    let calls = 0;
    const holder: { draft?: SearchDraft } = {};
    const { draft, asked } = fixture({
      active: 'c1',
      search: (payload) => {
        if (payload['mode'] !== 'data') return {};
        calls++;
        if (calls === 1) void holder.draft!.cancel();
        return { data: [] };
      },
    });
    holder.draft = draft;
    draft.model.update((model) => ({ ...model, text: 'x', connection: 'c1' }));
    draft.tables.set([
      { name: 'a', path: ['a'], chosen: true },
      { name: 'b', path: ['b'], chosen: true },
    ]);
    await draft.findData();
    expect(calls).toBe(1);
    expect(draft.error()).toBe('');
    expect(asked.some(([operation]) => operation === 'db.cancel')).toBe(true);
    await draft.cancel();

    const failing = fixture({
      active: 'c1',
      search: (payload) => {
        if (payload['mode'] === 'data') throw new Error('timeout');
        return {};
      },
    });
    failing.draft.model.update((model) => ({ ...model, text: 'x', connection: 'c1' }));
    failing.draft.tables.set([{ name: 'a', path: ['a'], chosen: true }]);
    await failing.draft.findData();
    expect(failing.draft.error()).toBe('timeout');
  });
});
