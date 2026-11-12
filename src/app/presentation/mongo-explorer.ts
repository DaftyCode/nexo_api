import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { JsonFormat, ResultsView } from './mongo-results';
import { MongoDialog } from './mongo-dialog';
import { MongoWrites } from './mongo-writes';
import { MongoIndexes } from './mongo-indexes';
import { MongoExplain } from './mongo-explain';
import { MongoProfiler } from './mongo-profiler';
import { formatBytes } from '../domain/mongo-indexes';
import { WRITE_CONCERNS, WriteConcernChoice, changeValue } from '../domain/mongo-write';
import { MongoBrowser } from './mongo-explorer/browser';
import { MongoExplains } from './mongo-explorer/explains';
import { MongoQueryLibrary } from './mongo-explorer/library';
import { MongoPager } from './mongo-explorer/pager';
import { MongoExplorerDocuments } from './mongo-explorer-documents';
import { MongoExplorerSidebar } from './mongo-explorer-sidebar';
import { MongoTransfer } from './mongo-transfer';
import { MongoAggregations } from './mongo-aggregations';
import { AggregationEditor } from './mongo-aggregations/editor';
import { MongoTransfers } from './mongo-transfer/transfers';
import { MONGO, TRANSFER_FILES } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { resolveVariables } from '../domain/variables';
import { connectionValue } from '../domain/mongo';
import {
  BuiltQuery,
  CollectionStats,
  CollectionSummary,
  QueryFieldError,
  QueryForm,
  buildQuery,
  emptyQueryForm,
} from '../domain/mongo-query';
import type { QueryTarget } from '../application/mongo-use-cases';

/** The views of a collection. */
export type ExplorerTab = 'documents' | 'aggregations' | 'indexes' | 'explain' | 'profiler';

interface QueryModel extends QueryForm {
  /** Name and folder to save the query with. */
  name: string;
  folder: string;
  pageSize: string;
}

export const PAGE_SIZES = ['20', '50', '100', '500', '1000'];

/**
 * Browses a saved connection: its databases and collections, and `find` queries on one of
 * them with their pages, count, cancellation, saved queries and history.
 */
@Component({
  imports: [
    TranslocoPipe,
    MongoDialog,
    MongoIndexes,
    MongoExplain,
    MongoProfiler,
    MongoExplorerSidebar,
    MongoExplorerDocuments,
    MongoTransfer,
    MongoAggregations,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-explorer',
  styleUrl: './mongo-explorer.scss',
  templateUrl: './mongo-explorer.html',
})
export class MongoExplorer {
  readonly connection = input.required<WorkspaceDocument>();
  readonly closed = output<void>();
  readonly state = inject(WorkspaceState);
  private readonly mongo = inject(MONGO);
  readonly pageSizes = PAGE_SIZES;
  readonly fieldLabels: Record<string, string> = {
    filter: 'Filter',
    projection: 'Projection',
    sort: 'Sort',
    collation: 'Collation',
    hint: 'Index hint',
    skip: 'Skip',
    limit: 'Limit',
  };

  readonly error = signal('');
  readonly notice = signal('');
  readonly target = signal<(QueryTarget & { kind: string }) | undefined>(undefined);
  readonly model = signal<QueryModel>({
    ...emptyQueryForm(),
    name: '',
    folder: '',
    pageSize: '50',
  });
  readonly fields = form(this.model);
  readonly moreOptions = signal(false);
  /** A field of the query that cannot be used, and why. */
  readonly problem = signal<
    { field: string; key: string; params: Record<string, unknown> } | undefined
  >(undefined);
  readonly view = signal<ResultsView>('table');
  readonly format = signal<JsonFormat>('shell');
  readonly tab = signal<ExplorerTab>('documents');
  /** The views a collection has: a view has no indexes of its own. */
  protected readonly tabs = computed<ExplorerTab[]>(() =>
    this.target()?.kind === 'view'
      ? ['documents', 'aggregations', 'explain', 'profiler']
      : ['documents', 'aggregations', 'indexes', 'explain', 'profiler'],
  );
  readonly color = computed(() => connectionValue(this.connection().value).color ?? '');
  /** A read-only connection shows no write: the backend refuses them anyway. */
  readonly writable = computed(() => !connectionValue(this.connection().value).readOnly);
  readonly writeConcerns = WRITE_CONCERNS;
  readonly browser = new MongoBrowser(this);
  readonly pager = new MongoPager(this);
  readonly library = new MongoQueryLibrary(this);
  readonly explains = new MongoExplains(this);
  readonly transfers = new MongoTransfers(this, inject(TRANSFER_FILES));
  readonly aggregations = new AggregationEditor(this, inject(Injector));
  readonly writes = new MongoWrites({
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
    refresh: () => this.pager.find(this.pager.current()?.offset),
    reloadCollections: (database) => this.browser.loadCollections(database),
    reloadDatabases: () => this.browser.loadDatabases(),
    choose: (database, collection) => this.select(database, collection),
    fail: (error) => this.fail(error),
  });

  constructor() {
    effect(() => {
      this.connection();
      untracked(() => void this.browser.loadDatabases());
    });
    inject(DestroyRef).onDestroy(() => {
      this.pager.closeCursor();
      this.aggregations.runner.reset();
      this.transfers.close();
    });
  }

  async use<T>(action: (cases: Awaited<ReturnType<typeof this.mongo>>) => Promise<T>) {
    return action(await this.mongo());
  }
  fail(error: unknown) {
    this.error.set(this.state.describe(error));
  }
  /** Chooses a collection by its name, or none (after it was dropped). */
  private async select(database: string, name?: string) {
    if (!name) {
      this.pager.reset();
      this.target.set(undefined);
      this.browser.stats.set(undefined);
      return;
    }
    const found = this.browser.listed(database).find((c) => c.name === name) ?? {
      name,
      kind: 'collection' as const,
      capped: false,
    };
    this.choose(database, found);
  }
  undoable(change: WorkspaceDocument) {
    return changeValue(change.value).changes.length > 0;
  }
  setConcern(event: Event) {
    this.writes.concern.set((event.target as HTMLSelectElement).value as WriteConcernChoice);
  }
  /** Chooses a collection: its statistics load, and the query runs at once, as Compass does. */
  choose(database: string, collection: CollectionSummary, run = true) {
    const changed =
      this.target()?.database !== database || this.target()?.collection !== collection.name;
    this.target.set({ database, collection: collection.name, kind: collection.kind });
    if (collection.kind === 'view' && this.tab() === 'indexes') this.tab.set('documents');
    if (changed) {
      this.pager.reset();
      this.aggregations.runner.reset();
      this.browser.stats.set(undefined);
      if (collection.kind !== 'view') void this.browser.loadStats();
    }
    if (run) void this.pager.find();
  }
  /** The query of the bar, or `undefined` when a field cannot be used (it says why). */
  query(): BuiltQuery | undefined {
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
  setView(view: ResultsView) {
    this.view.set(view);
  }
  setFormat(event: Event) {
    this.format.set((event.target as HTMLSelectElement).value as JsonFormat);
  }
  readonly bytes = formatBytes;
  protected indexNames(stats: CollectionStats) {
    return stats.indexes.map((index) => index.name).join(', ');
  }
}
