import { computed, signal } from '@angular/core';
import { WorkspaceDocument } from '../../domain/models';
import { connectionFolders } from '../../domain/mongo';
import { MongoQueryValue, emptyQueryForm, queryValue } from '../../domain/mongo-query';
import { changeValue } from '../../domain/mongo-write';
import type { QueryTarget } from '../../application/mongo-use-cases';
import type { MongoExplorer } from '../mongo-explorer';
import { named } from '../workspace-state';

/** History entries shown for a connection. */
const HISTORY_SHOWN = 20;
/** Recorded writes shown for a connection. */
const CHANGES_SHOWN = 10;

/** The saved queries of the connection, its query history and its latest writes. */
export class MongoQueryLibrary {
  /** The saved query being edited, if one was opened. */
  readonly savedId = signal('');
  readonly savedQueries = computed(() =>
    connectionFolders(
      this.explorer.state
        .documents()
        .filter(
          (d) =>
            d.kind === 'query' && queryValue(d.value).connection === this.explorer.connection().id,
        ),
    ),
  );
  readonly folders = computed(() =>
    this.savedQueries()
      .map((group) => group.folder)
      .filter(Boolean),
  );
  readonly history = computed(() => this.latest('query-history', HISTORY_SHOWN));
  /** The latest writes of this connection, to undo them. */
  readonly changes = computed(() =>
    this.explorer.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'database-change' &&
          changeValue(d.value).connection === this.explorer.connection().id,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, CHANGES_SHOWN),
  );

  constructor(private readonly explorer: MongoExplorer) {}

  private latest(kind: string, shown: number) {
    return this.explorer.state
      .documents()
      .filter(
        (d) => d.kind === kind && queryValue(d.value).connection === this.explorer.connection().id,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, shown);
  }
  /** The query as it is stored: where it runs and its fields as typed. */
  private value(target: QueryTarget): MongoQueryValue {
    const { name: _, pageSize: __, folder: ___, ...form } = this.explorer.model();
    const { database, collection } = target;
    return { ...form, connection: this.explorer.connection().id, database, collection };
  }
  /** Adds the query to the history, unless it is the one there already. */
  async record(target: QueryTarget) {
    const value = this.value(target);
    const last = this.history()[0];
    if (last && JSON.stringify(queryValue(last.value)) === JSON.stringify(queryValue(value)))
      return;
    const { explorer } = this;
    try {
      const saved = await explorer.use((cases) =>
        cases.queries.recordHistory(explorer.state.workspaceId(), value),
      );
      explorer.state.applySaved([saved]);
    } catch {
      // The history is a convenience: the query already ran.
    }
  }
  async save() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target) return;
    explorer.error.set('');
    explorer.notice.set('');
    await explorer.state.announce('The query could not be saved', async () => {
      const existing = explorer.state.documents().find((d) => d.id === this.savedId());
      const saved = await explorer.use((cases) =>
        cases.queries.saveQuery(
          explorer.state.workspaceId(),
          explorer.model().name,
          { ...this.value(target), folder: explorer.model().folder.trim() },
          existing,
        ),
      );
      explorer.state.applySaved([saved]);
      this.savedId.set(saved.id);
      explorer.model.update((model) => ({ ...model, name: saved.name }));
      return named('Query saved', saved.name);
    });
  }
  async remove(document: WorkspaceDocument) {
    const { explorer } = this;
    if (!explorer.state.confirm('Delete this saved query?')) return;
    explorer.error.set('');
    await explorer.state.announce('The query could not be deleted', async () => {
      await explorer.use((cases) => cases.queries.removeQuery(document));
      explorer.state.forget(document);
      if (this.savedId() === document.id) this.savedId.set('');
      return named('Query deleted', document.name);
    });
  }
  /** Opens a saved query or one of the history: its collection is chosen and it runs. */
  async open(document: WorkspaceDocument, saved: boolean) {
    const { explorer } = this;
    const value = await explorer.use((cases) => cases.queries.historyQuery(document));
    this.savedId.set(saved ? document.id : '');
    const { connection: _, database, collection, folder: __, ...form } = value;
    explorer.model.update((model) => ({
      ...model,
      ...form,
      name: saved ? document.name : '',
      folder: saved ? (value.folder ?? '') : '',
    }));
    explorer.moreOptions.set(!!(form.collation || form.hint || form.skip || form.limit));
    const browser = explorer.browser;
    if (!browser.collections()[database]) await browser.loadCollections(database);
    const found = browser.listed(database).find((c) => c.name === collection) ?? {
      name: collection,
      kind: 'collection' as const,
      capped: false,
    };
    explorer.choose(database, found);
  }
  newQuery() {
    this.savedId.set('');
    this.explorer.model.update((model) => ({
      ...model,
      ...emptyQueryForm(),
      name: '',
      folder: '',
    }));
    this.explorer.problem.set(undefined);
  }
}
