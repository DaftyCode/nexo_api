import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { CodeEditor } from './code-editor';
import { JsonFormat, MongoResults, ResultsView } from './mongo-results';
import { MongoDialog } from './mongo-dialog';
import { MongoWrites } from './mongo-writes';
import { WRITE_CONCERNS, WriteConcernChoice, changeValue } from '../domain/mongo-write';
import { MONGO } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { resolveVariables } from '../domain/variables';
import { connectionFolders, connectionValue } from '../domain/mongo';
import {
  BuiltQuery,
  CollectionStats,
  CollectionSummary,
  DatabaseSummary,
  MongoQueryValue,
  QueryFieldError,
  QueryForm,
  buildQuery,
  emptyQueryForm,
  queryValue,
} from '../domain/mongo-query';
import type { QueryTarget } from '../application/mongo-use-cases';

interface QueryModel extends QueryForm {
  /** Name and folder to save the query with. */
  name: string;
  folder: string;
  pageSize: string;
}

/** A page of results already read, and where it starts. */
interface Page {
  offset: number;
  documents: Record<string, unknown>[];
  truncated: boolean;
  elapsedMs: number;
}

/** Pages kept to go back without asking the server again. */
const KEPT_PAGES = 5;
/** History entries shown for a connection. */
const HISTORY_SHOWN = 20;
/** Recorded writes shown for a connection. */
const CHANGES_SHOWN = 10;
export const PAGE_SIZES = ['20', '50', '100', '500', '1000'];

/**
 * Browses a saved connection: its databases and collections, and `find` queries on one of
 * them with their pages, count, cancellation, saved queries and history.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoResults, MongoDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-explorer',
  styleUrl: './mongo-explorer.scss',
  templateUrl: './mongo-explorer.html',
})
export class MongoExplorer {
  readonly connection = input.required<WorkspaceDocument>();
  readonly closed = output<void>();
  protected readonly state = inject(WorkspaceState);
  private readonly mongo = inject(MONGO);
  protected readonly pageSizes = PAGE_SIZES;
  protected readonly fieldLabels: Record<string, string> = {
    filter: 'Filter',
    projection: 'Projection',
    sort: 'Sort',
    collation: 'Collation',
    hint: 'Index hint',
    skip: 'Skip',
    limit: 'Limit',
  };

  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly loadingDatabases = signal(false);
  protected readonly databases = signal<DatabaseSummary[]>([]);
  /** Collections of the databases opened in the tree. */
  protected readonly collections = signal<Record<string, CollectionSummary[] | 'loading'>>({});
  protected readonly target = signal<(QueryTarget & { kind: string }) | undefined>(undefined);
  protected readonly stats = signal<CollectionStats | undefined>(undefined);

  protected readonly model = signal<QueryModel>({
    ...emptyQueryForm(),
    name: '',
    folder: '',
    pageSize: '50',
  });
  protected readonly fields = form(this.model);
  protected readonly moreOptions = signal(false);
  /** A field of the query that cannot be used, and why. */
  protected readonly problem = signal<
    { field: string; key: string; params: Record<string, unknown> } | undefined
  >(undefined);

  /** The query whose pages are shown, as it was sent. */
  private ran: { target: QueryTarget; query: BuiltQuery; pageSize: number } | undefined;
  protected readonly pages = signal<Page[]>([]);
  protected readonly page = signal(0);
  /** The open cursor after the newest page read. */
  private readonly cursor = signal<string | undefined>(undefined);
  protected readonly running = signal<string | undefined>(undefined);
  protected readonly total = signal<number | undefined>(undefined);
  protected readonly view = signal<ResultsView>('table');
  protected readonly format = signal<JsonFormat>('shell');
  /** The saved query being edited, if one was opened. */
  protected readonly savedId = signal('');

  protected readonly color = computed(() => connectionValue(this.connection().value).color ?? '');
  /** A read-only connection shows no write: the backend refuses them anyway. */
  protected readonly writable = computed(() => !connectionValue(this.connection().value).readOnly);
  protected readonly writeConcerns = WRITE_CONCERNS;
  protected readonly writes = new MongoWrites({
    state: this.state,
    cases: () => this.mongo(),
    connection: () => this.connection(),
    target: () => {
      const target = this.target();
      return target && { database: target.database, collection: target.collection };
    },
    filter: () => {
      const query = this.query();
      return query && (query.filter ?? {});
    },
    refresh: () => this.find(this.current()?.offset),
    reloadCollections: (database) => this.loadCollections(database),
    reloadDatabases: () => this.loadDatabases(),
    choose: (database, collection) => this.select(database, collection),
    fail: (error) => this.fail(error),
  });
  /** The latest writes of this connection, to undo them. */
  protected readonly changes = computed(() =>
    this.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'database-change' && changeValue(d.value).connection === this.connection().id,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, CHANGES_SHOWN),
  );
  protected readonly current = computed<Page | undefined>(() => this.pages()[this.page()]);
  protected readonly hasNext = computed(() => {
    const pages = this.pages();
    return this.page() < pages.length - 1 || (this.page() === pages.length - 1 && !!this.cursor());
  });
  protected readonly hasPrevious = computed(
    () => (this.current()?.offset ?? 0) > (this.ran?.query.skip ?? 0) || this.page() > 0,
  );
  protected readonly queryFolders = computed(() =>
    this.savedQueries()
      .map((group) => group.folder)
      .filter(Boolean),
  );
  protected readonly savedQueries = computed(() =>
    connectionFolders(
      this.state
        .documents()
        .filter(
          (d) => d.kind === 'query' && queryValue(d.value).connection === this.connection().id,
        ),
    ),
  );
  protected readonly history = computed(() =>
    this.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'query-history' && queryValue(d.value).connection === this.connection().id,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, HISTORY_SHOWN),
  );

  constructor() {
    effect(() => {
      this.connection();
      untracked(() => void this.loadDatabases());
    });
    inject(DestroyRef).onDestroy(() => this.closeCursor());
  }

  private async use<T>(action: (cases: Awaited<ReturnType<typeof this.mongo>>) => Promise<T>) {
    return action(await this.mongo());
  }
  private fail(error: unknown) {
    this.error.set(this.state.describe(error));
  }

  protected async loadDatabases() {
    this.error.set('');
    this.loadingDatabases.set(true);
    try {
      const databases = await this.use((cases) =>
        cases.databases(this.state.workspaceId(), this.connection(), this.state.scopes()),
      );
      this.databases.set(databases);
      // Databases that were open stay open, with their collections listed again.
      const open = Object.keys(this.collections()).filter((name) =>
        databases.some((database) => database.name === name),
      );
      this.collections.set({});
      await Promise.all(open.map((name) => this.loadCollections(name)));
    } catch (error) {
      this.fail(error);
    } finally {
      this.loadingDatabases.set(false);
    }
  }

  /** Opens or closes a database in the tree, listing its collections the first time. */
  protected async toggleDatabase(name: string) {
    const known = this.collections()[name];
    if (known) {
      this.collections.update(({ [name]: _, ...rest }) => rest);
      return;
    }
    await this.loadCollections(name);
  }
  /** Chooses a collection by its name, or none (after it was dropped). */
  private async select(database: string, name?: string) {
    if (!name) {
      this.reset();
      this.target.set(undefined);
      this.stats.set(undefined);
      return;
    }
    const found = this.listed(database).find((c) => c.name === name) ?? {
      name,
      kind: 'collection' as const,
      capped: false,
    };
    this.choose(database, found);
  }
  protected undoable(change: WorkspaceDocument) {
    return changeValue(change.value).changes.length > 0;
  }
  protected setConcern(event: Event) {
    this.writes.concern.set((event.target as HTMLSelectElement).value as WriteConcernChoice);
  }
  private async loadCollections(name: string) {
    this.collections.update((all) => ({ ...all, [name]: 'loading' }));
    try {
      const listed = await this.use((cases) =>
        cases.collections(this.state.workspaceId(), this.connection(), this.state.scopes(), name),
      );
      this.collections.update((all) => ({ ...all, [name]: listed }));
    } catch (error) {
      this.collections.update(({ [name]: _, ...rest }) => rest);
      this.fail(error);
    }
  }
  protected listed(name: string): CollectionSummary[] {
    const listed = this.collections()[name];
    return Array.isArray(listed) ? listed : [];
  }
  protected kindLabel(collection: CollectionSummary) {
    if (collection.gridfs) return 'GridFS';
    if (collection.kind === 'view') return 'View';
    if (collection.kind === 'timeseries') return 'Time series';
    if (collection.name.startsWith('system.')) return 'System';
    return '';
  }

  /** Chooses a collection: its statistics load, and the query runs at once, as Compass does. */
  protected choose(database: string, collection: CollectionSummary, run = true) {
    const changed =
      this.target()?.database !== database || this.target()?.collection !== collection.name;
    this.target.set({ database, collection: collection.name, kind: collection.kind });
    if (changed) {
      this.reset();
      this.stats.set(undefined);
      if (collection.kind !== 'view') void this.loadStats();
    }
    if (run) void this.find();
  }
  private async loadStats() {
    const target = this.target();
    if (!target) return;
    try {
      const stats = await this.use((cases) =>
        cases.stats(this.state.workspaceId(), this.connection(), this.state.scopes(), target),
      );
      if (this.target() === target) this.stats.set(stats);
    } catch {
      // Some servers and time series collections have no statistics: the query still works.
    }
  }

  private query(): BuiltQuery | undefined {
    this.problem.set(undefined);
    try {
      const scopes = this.state.scopes();
      return buildQuery(this.model(), (text) => resolveVariables(text, scopes));
    } catch (error) {
      if (error instanceof QueryFieldError) {
        this.problem.set({ field: error.field, key: error.key, params: error.params });
        if (error.field !== 'filter' && error.field !== 'projection' && error.field !== 'sort')
          this.moreOptions.set(true);
        return undefined;
      }
      throw error;
    }
  }

  /** Runs the query and shows its first page. */
  protected async find(skipFrom?: number) {
    const target = this.target();
    if (!target || this.running()) return;
    const query = this.query();
    if (!query) return;
    const pageSize = Number(this.model().pageSize) || 50;
    const first = skipFrom === undefined;
    const offset = skipFrom ?? query.skip ?? 0;
    const sent: BuiltQuery = { ...query };
    if (offset) sent.skip = offset;
    if (query.limit) {
      const left = query.limit - (offset - (query.skip ?? 0));
      if (left <= 0) return;
      sent.limit = left;
    }
    this.closeCursor();
    const id = crypto.randomUUID();
    this.running.set(id);
    this.error.set('');
    try {
      const page = await this.use((cases) =>
        cases.find(
          this.state.workspaceId(),
          this.connection(),
          this.state.scopes(),
          target,
          sent,
          id,
          pageSize,
        ),
      );
      this.ran = { target, query, pageSize };
      this.pages.set([{ offset, ...page }]);
      this.page.set(0);
      this.cursor.set(page.cursor);
      if (first) {
        this.total.set(undefined);
        void this.record(target);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }

  protected async next() {
    const pages = this.pages();
    const index = this.page();
    if (index < pages.length - 1) {
      this.page.set(index + 1);
      return;
    }
    const cursor = this.cursor();
    const current = pages[index];
    if (!cursor || !current || !this.ran || this.running()) return;
    const id = crypto.randomUUID();
    this.running.set(id);
    this.error.set('');
    try {
      const page = await this.use((cases) =>
        cases.more(this.state.workspaceId(), cursor, id, this.ran?.pageSize ?? 50),
      );
      const offset = current.offset + current.documents.length;
      this.pages.update((kept) => [...kept, { offset, ...page }].slice(-KEPT_PAGES));
      this.page.set(Math.min(index + 1, KEPT_PAGES - 1));
      this.cursor.set(page.cursor);
    } catch (error) {
      this.cursor.set(undefined);
      this.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }

  protected async previous() {
    const index = this.page();
    if (index > 0) {
      this.page.set(index - 1);
      return;
    }
    // Older than the pages kept: the query runs again from there.
    const current = this.current();
    if (!current || !this.ran) return;
    const start = Math.max(this.ran.query.skip ?? 0, current.offset - this.ran.pageSize);
    await this.find(start);
  }

  protected async count() {
    const target = this.target();
    if (!target || this.running()) return;
    const query = this.query();
    if (!query) return;
    const id = crypto.randomUUID();
    this.running.set(id);
    this.error.set('');
    try {
      this.total.set(
        await this.use((cases) =>
          cases.count(
            this.state.workspaceId(),
            this.connection(),
            this.state.scopes(),
            target,
            query,
            id,
          ),
        ),
      );
    } catch (error) {
      this.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }

  protected async cancel() {
    const id = this.running();
    if (!id) return;
    try {
      await this.use((cases) => cases.cancel(this.state.workspaceId(), id));
    } catch (error) {
      this.fail(error);
    }
  }

  private closeCursor() {
    const cursor = this.cursor();
    this.cursor.set(undefined);
    if (cursor) void this.use((cases) => cases.close(this.state.workspaceId(), cursor));
  }

  private reset() {
    this.closeCursor();
    this.pages.set([]);
    this.page.set(0);
    this.total.set(undefined);
    this.ran = undefined;
  }

  /** The query as it is stored: where it runs and its fields as typed. */
  private value(target: QueryTarget): MongoQueryValue {
    const { name: _, pageSize: __, folder: ___, ...form } = this.model();
    const { database, collection } = target;
    return { ...form, connection: this.connection().id, database, collection };
  }

  /** Adds the query to the history, unless it is the one there already. */
  private async record(target: QueryTarget) {
    const value = this.value(target);
    const last = this.history()[0];
    if (last && JSON.stringify(queryValue(last.value)) === JSON.stringify(queryValue(value)))
      return;
    try {
      const saved = await this.use((cases) => cases.recordHistory(this.state.workspaceId(), value));
      this.state.applySaved([saved]);
    } catch {
      // The history is a convenience: the query already ran.
    }
  }

  protected async save() {
    const target = this.target();
    if (!target) return;
    this.error.set('');
    try {
      const existing = this.state.documents().find((d) => d.id === this.savedId());
      const saved = await this.use((cases) =>
        cases.saveQuery(
          this.state.workspaceId(),
          this.model().name,
          { ...this.value(target), folder: this.model().folder.trim() },
          existing,
        ),
      );
      this.state.applySaved([saved]);
      this.savedId.set(saved.id);
      this.model.update((model) => ({ ...model, name: saved.name }));
      this.notice.set('Query saved');
    } catch (error) {
      this.fail(error);
    }
  }

  protected async removeSaved(document: WorkspaceDocument) {
    if (!this.state.confirm('Delete this saved query?')) return;
    try {
      await this.use((cases) => cases.removeQuery(document));
      this.state.forget(document);
      if (this.savedId() === document.id) this.savedId.set('');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Opens a saved query or one of the history: its collection is chosen and it runs. */
  protected async openQuery(document: WorkspaceDocument, saved: boolean) {
    const value = await this.use((cases) => cases.historyQuery(document));
    this.savedId.set(saved ? document.id : '');
    const { connection: _, database, collection, folder: __, ...form } = value;
    this.model.update((model) => ({
      ...model,
      ...form,
      name: saved ? document.name : '',
      folder: saved ? (value.folder ?? '') : '',
    }));
    this.moreOptions.set(!!(form.collation || form.hint || form.skip || form.limit));
    if (!this.collections()[database]) await this.loadCollections(database);
    const found = this.listed(database).find((c) => c.name === collection) ?? {
      name: collection,
      kind: 'collection' as const,
      capped: false,
    };
    this.choose(database, found);
  }

  protected newQuery() {
    this.savedId.set('');
    this.model.update((model) => ({ ...model, ...emptyQueryForm(), name: '', folder: '' }));
    this.problem.set(undefined);
  }

  protected setView(view: ResultsView) {
    this.view.set(view);
  }
  protected setFormat(event: Event) {
    this.format.set((event.target as HTMLSelectElement).value as JsonFormat);
  }
  protected bytes(size: number | undefined) {
    if (size === undefined) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }
  protected indexNames(stats: CollectionStats) {
    return stats.indexes.map((index) => index.name).join(', ');
  }
}
