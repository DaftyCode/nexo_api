import { Injector, signal } from '@angular/core';
import { FieldTree, form } from '@angular/forms/signals';
import { DataHit, ObjectHit, ScriptHit, dataWhere, findInScripts } from '../../domain/db/search';
import { readScript } from '../../domain/db/sql';
import type { DbSection } from './section';

/** The kinds of objects searched, as `db.search` names them. */
export const OBJECT_KINDS = ['table', 'view', 'column', 'index', 'function', 'constraint'] as const;

export function searchModel(connection: string) {
  return {
    text: '',
    /** Objects: in the code of views and routines too, and only in these schemas. */
    code: false,
    schemas: '',
    /** Data: the connection, the tables named like, and how values match. */
    connection,
    tables: '%',
    caseSensitive: false,
    wholeWord: false,
    texts: true,
    numbers: true,
    maxRows: 100,
    /** Data on production: the person knows it may read whole tables. */
    confirm: false,
  };
}
export type SearchModel = ReturnType<typeof searchModel>;

/** A table offered to the data search. */
export interface SearchTableChoice {
  schema?: string;
  name: string;
  path: string[];
  chosen: boolean;
}

/**
 * The search dialog while it is open (DB-18): what is looked for, the sessions it opens on
 * the connections (its own, closed with it), and what it found.
 */
export class SearchDraft {
  readonly model = signal<SearchModel>(searchModel(''));
  readonly fields: FieldTree<SearchModel>;
  readonly connections = signal<ReadonlySet<string>>(new Set());
  readonly kinds = signal<ReadonlySet<string>>(new Set(OBJECT_KINDS));
  readonly objects = signal<
    { connection: string; hits: ObjectHit[]; more: boolean; error?: string }[]
  >([]);
  readonly tables = signal<SearchTableChoice[]>([]);
  readonly data = signal<DataHit[]>([]);
  readonly scripts = signal<ScriptHit[]>([]);
  readonly progress = signal({ done: 0, total: 0 });
  readonly running = signal(false);
  readonly error = signal('');
  readonly recent = signal<string[]>([]);
  private readonly sessions = new Map<string, string>();
  private current?: { session: string; statement: string };
  private stopped = false;

  constructor(
    readonly section: DbSection,
    injector: Injector,
  ) {
    const active = section.active();
    this.model.set(searchModel(active));
    this.fields = form(this.model, { injector });
    if (active) this.connections.set(new Set([active]));
    void section.cases().then((cases) => this.recent.set(cases.search.recent()));
  }

  private workspace() {
    return this.section.state.workspaceId();
  }
  private async session(connection: string) {
    const open = this.sessions.get(connection);
    if (open) return open;
    const document = this.section.connection(connection);
    if (!document) throw new Error('The connection is no longer there');
    const driver = document.value as { driver?: string };
    if (!(await this.section.ensure(String(driver.driver ?? ''))))
      throw new Error('The module of the connection is not installed');
    const session = `search:${connection}:${Date.now()}`;
    const cases = await this.section.cases();
    await cases.statements.open(this.workspace(), document, session, this.section.state.scopes(), {
      manual: false,
    });
    this.sessions.set(connection, session);
    return session;
  }

  async close() {
    const cases = await this.section.cases();
    for (const session of this.sessions.values())
      await cases.statements.close(this.workspace(), session).catch(() => undefined);
    this.sessions.clear();
  }

  toggle(set: 'connections' | 'kinds', value: string) {
    this[set].update((all) => {
      const next = new Set(all);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  private async remember() {
    const cases = await this.section.cases();
    cases.search.remember(this.model().text.trim());
    this.recent.set(cases.search.recent());
  }

  /** Objects named like the text, in every connection chosen. */
  async findObjects() {
    const model = this.model();
    this.running.set(true);
    this.objects.set([]);
    const cases = await this.section.cases();
    try {
      for (const connection of this.connections()) {
        try {
          const session = await this.session(connection);
          const answer = await cases.search.search(
            this.workspace(),
            session,
            `search-${Date.now()}`,
            {
              mode: 'metadata',
              text: model.text,
              kinds: [...this.kinds()],
              code: model.code,
              schemas: model.schemas
                .split(',')
                .map((schema) => schema.trim())
                .filter(Boolean),
            },
          );
          const found = { connection, hits: answer.objects ?? [], more: !!answer.more };
          this.objects.update((all) => [...all, found]);
        } catch (error) {
          const failed = {
            connection,
            hits: [],
            more: false,
            error: this.section.state.describe(error),
          };
          this.objects.update((all) => [...all, failed]);
        }
      }
      await this.remember();
    } finally {
      this.running.set(false);
    }
  }

  /** The tables of the data search's connection named like its pattern. */
  async findTables() {
    const model = this.model();
    this.error.set('');
    try {
      const cases = await this.section.cases();
      const session = await this.session(model.connection);
      const answer = await cases.search.search(this.workspace(), session, `tables-${Date.now()}`, {
        mode: 'metadata',
        text: model.tables || '%',
        kinds: ['table', 'view'],
        max: 2000,
      });
      this.tables.set((answer.objects ?? []).map((hit) => ({ ...hit, chosen: true })));
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    }
  }

  /** The value in the data of the tables chosen, one table at a time. */
  async findData() {
    const model = this.model();
    const chosen = this.tables().filter((table) => table.chosen);
    this.running.set(true);
    this.stopped = false;
    this.error.set('');
    this.data.set([]);
    this.progress.set({ done: 0, total: chosen.length });
    try {
      const cases = await this.section.cases();
      const session = await this.session(model.connection);
      for (const table of chosen) {
        if (this.stopped) break;
        const statement = `search-${Date.now()}`;
        this.current = { session, statement };
        const answer = await cases.search.search(this.workspace(), session, statement, {
          mode: 'data',
          text: model.text,
          tables: [
            {
              ...(table.schema ? { schema: table.schema } : {}),
              name: table.name,
              path: table.path,
            },
          ],
          caseSensitive: model.caseSensitive,
          wholeWord: model.wholeWord,
          columns: [
            ...(model.texts ? ['text' as const] : []),
            ...(model.numbers ? ['number' as const] : []),
          ],
          maxRows: model.maxRows,
          ...(model.confirm ? { confirm: true } : {}),
        });
        this.data.update((all) => [...all, ...(answer.data ?? [])]);
        this.progress.update((progress) => ({ ...progress, done: progress.done + 1 }));
      }
      await this.remember();
    } catch (error) {
      if (!this.stopped) this.error.set(this.section.state.describe(error));
    } finally {
      this.current = undefined;
      this.running.set(false);
    }
  }

  /** Stops the data search, cancelling the query running on the server. */
  async cancel() {
    this.stopped = true;
    const current = this.current;
    if (!current) return;
    const cases = await this.section.cases();
    await cases.statements
      .cancel(this.workspace(), current.session, current.statement)
      .catch(() => undefined);
  }

  /** The text in the saved scripts and the history. */
  async findScripts() {
    const cases = await this.section.cases();
    // The history grows as statements run: read it as it is now.
    await this.section.state.refresh();
    const history = await cases.statements.entries(this.section.state.documents());
    const scripts = this.section.scripts().map((document) => {
      const value = readScript(document.value);
      return {
        kind: 'script' as const,
        id: document.id,
        name: document.name,
        connection: value.connectionId,
        sql: value.sql,
      };
    });
    const entries = history.map((entry) => ({
      kind: 'history' as const,
      id: entry.id,
      name: new Date(entry.startedAt).toLocaleString(),
      connection: entry.connectionId,
      sql: entry.sql,
    }));
    this.scripts.set(
      findInScripts([...scripts, ...entries], this.model().text, this.model().caseSensitive),
    );
    await this.remember();
  }

  openObject(connection: string, hit: ObjectHit) {
    this.section.tabs.open({ kind: 'object', connection, title: hit.name, path: hit.path });
  }
  openData(hit: DataHit) {
    const connection = this.model().connection;
    const where = dataWhere(hit.matched, this.model().text, this.section.sqlStyle(connection));
    this.section.tabs.open({
      kind: 'object',
      connection,
      title: hit.table,
      path: hit.path,
      part: 'data',
      query: { where, quick: [], order: [] },
    });
  }
  openScript(hit: ScriptHit) {
    if (hit.kind === 'script') this.section.openScript(hit.id, hit.offset);
    else this.section.newScript(hit.connection, { text: hit.sql });
  }
}
