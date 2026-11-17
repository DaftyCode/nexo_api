import { describe, expect, it } from 'vitest';
import { DatabaseUseCases } from '../../application/database-use-cases';
import type { NavigatorRow } from '../../domain/db/rows';
import { generateSql } from './generate';
import { PanelTask } from '../panel-task';
import { copyDdl, copyName, newObject, refreshView } from './node-scripts';
import type { DbSection } from './section';
import { StructureDraft } from './structure-draft';

const row = (extra: Partial<NavigatorRow>): NavigatorRow =>
  ({
    key: 'k',
    type: 'node',
    level: 1,
    label: 'x',
    expandable: false,
    expanded: false,
    ...extra,
  }) as NavigatorRow;

function fixture(
  options: { documents?: Record<string, unknown>[]; installed?: boolean; dialect?: string } = {},
) {
  const asked: [string, Record<string, unknown>][] = [];
  const scripts: unknown[] = [];
  const cases = new DatabaseUseCases({
    execute: async (operation: string, payload: Record<string, unknown>) => {
      asked.push([operation, payload]);
      if (operation === 'db.ddl.model') return { table: { name: 't', columns: [] }, types: [] };
      if (operation === 'db.execute') return { columns: [], rows: [], elapsedMs: 1 };
      if (operation === 'db.close') throw new Error('gone');
      return { serverVersion: '1', tls: false };
    },
  } as never);
  const documents = options.documents ?? [];
  const section = {
    cases: async () => cases,
    connection: (id: string) => documents.find((document) => document['id'] === id),
    ensure: async () => options.installed !== false,
    learnQuotes: async () => {
      throw new Error('no driver');
    },
    quoteStyle: () => ({ quoteOpen: '"', quoteClose: '"' }),
    sqlStyle: () => ({ name: options.dialect ?? 'postgresql', quoteOpen: '"', quoteClose: '"' }),
    nodesAlong: () => [],
    newScript: (connection: string, script: unknown) => void scripts.push([connection, script]),
    schema: { clear: () => undefined },
    tree: {
      refresh: async () => {
        throw new Error('offline');
      },
    },
    state: {
      workspaceId: () => 'w',
      scopes: () => ({ environment: [], collection: [], globals: [] }),
      describe: (error: unknown) => (error as Error).message,
      tell: () => undefined,
    },
  } as unknown as DbSection;
  return { section, asked, scripts };
}

describe('the actions of a node, at their edges', () => {
  it('does nothing for a row without a connection, a path or a template', async () => {
    const { section, asked, scripts } = fixture();
    const task = new PanelTask(section.state);
    copyName(section, task, row({}));
    copyDdl(section, task, row({ connection: 'c1' }));
    await newObject(section, row({ connection: 'c1', path: ['t'] }));
    await newObject(
      section,
      row({ connection: 'c1', path: ['tables'], node: { name: 'tables' } as never }),
    );
    await refreshView(section, row({}));
    await generateSql(section, row({ connection: 'c1' }), 'select');
    expect(asked).toEqual([]);
    expect(scripts).toEqual([]);
  });

  it('opens a template and a refresh even when the driver says nothing, on the database of the node', async () => {
    const { section, scripts } = fixture({
      documents: [{ id: 'c1', value: { driver: 'postgres' } }],
    });
    await newObject(
      section,
      row({ connection: 'c1', path: ['schemas'], node: { name: 'schemas' } as never }),
    );
    await refreshView(section, row({ connection: 'c1', path: ['m', 'v'], label: 'v' }));
    expect(scripts.map((each) => (each as [string, { text: string }])[1].text)).toEqual([
      'CREATE SCHEMA new_schema',
      'REFRESH MATERIALIZED VIEW ',
    ]);
  });
});

describe('the structure draft, at its edges', () => {
  it('says when the connection is gone or its module is not installed', async () => {
    const gone = new StructureDraft(fixture().section, 'c1', ['t'], false);
    await gone.load();
    expect(gone.error()).toBe('The connection is no longer there');
    const missing = fixture({ documents: [{ id: 'c1', value: {} }], installed: false });
    const draft = new StructureDraft(missing.section, 'c1', ['t'], false);
    await draft.load();
    expect(draft.error()).toBe('The module of the connection is not installed');
    await draft.close();
    draft.revert();
    expect(await draft.run()).toBe(false);
  });

  it('creates in no schema at the top, empties a SQLite table with DELETE and closes its session', async () => {
    const { section, asked } = fixture({
      documents: [{ id: 'c1', value: { driver: 'sqlite' } }],
      dialect: 'sqlite',
    });
    const created = new StructureDraft(section, 'c1', ['tables'], true);
    await created.load('items');
    expect(created.table().schema).toBeUndefined();
    expect(await created.empty('"items"', 'items')).toBe(true);
    expect(
      asked
        .filter(([operation]) => operation === 'db.execute')
        .map(([, payload]) => payload['sql']),
    ).toEqual(['DELETE FROM "items"']);
    created.plan.set({
      statements: ['CREATE TABLE items (id int)'],
      warnings: [],
      transactional: false,
    });
    created.script.set('CREATE TABLE items (id int)');
    expect(await created.run()).toBe(true);
    await created.close();
    await created.close();
  });
});
