import { signal } from '@angular/core';
import { CollectionStats, CollectionSummary, DatabaseSummary } from '../../domain/mongo-query';
import type { MongoExplorer } from '../mongo-explorer';

/** The databases of the connection and the collections of those opened in the tree. */
export class MongoBrowser {
  readonly loading = signal(false);
  readonly databases = signal<DatabaseSummary[]>([]);
  /** Collections of the databases opened in the tree. */
  readonly collections = signal<Record<string, CollectionSummary[] | 'loading'>>({});
  readonly stats = signal<CollectionStats | undefined>(undefined);

  constructor(private readonly explorer: MongoExplorer) {}

  async loadDatabases() {
    const { explorer } = this;
    explorer.error.set('');
    this.loading.set(true);
    try {
      const databases = await explorer.use((cases) =>
        cases.connections.databases(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
        ),
      );
      this.databases.set(databases);
      // Databases that were open stay open, with their collections listed again.
      const open = Object.keys(this.collections()).filter((name) =>
        databases.some((database) => database.name === name),
      );
      this.collections.set({});
      await Promise.all(open.map((name) => this.loadCollections(name)));
    } catch (error) {
      explorer.fail(error);
    } finally {
      this.loading.set(false);
    }
  }
  /** Opens or closes a database in the tree, listing its collections the first time. */
  async toggleDatabase(name: string) {
    const known = this.collections()[name];
    if (known) {
      this.collections.update(({ [name]: _, ...rest }) => rest);
      return;
    }
    await this.loadCollections(name);
  }
  /**
   * Shows a collection by name, listing its database first: the navigator's runs its query,
   * as choosing it here does; a saved query or pipeline only chooses it (`run` false).
   */
  async show(database: string, name: string, run = true) {
    const { explorer } = this;
    const target = explorer.target();
    if (run && target?.database === database && target.collection === name) {
      explorer.shellOpen.set(false);
      return;
    }
    if (!this.collections()[database]) await this.loadCollections(database);
    explorer.choose(database, this.found(database, name), run);
  }
  /** Chooses a collection by its name, or none (after it was dropped). */
  async select(database: string, name?: string) {
    const { explorer } = this;
    if (name) return explorer.choose(database, this.found(database, name));
    explorer.pager.reset();
    explorer.target.set(undefined);
    this.stats.set(undefined);
  }
  private found(database: string, name: string): CollectionSummary {
    const listed = this.listed(database).find((collection) => collection.name === name);
    return listed ?? { name, kind: 'collection', capped: false };
  }
  async loadCollections(name: string) {
    const { explorer } = this;
    this.collections.update((all) => ({ ...all, [name]: 'loading' }));
    try {
      const listed = await explorer.use((cases) =>
        cases.connections.collections(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          name,
        ),
      );
      this.collections.update((all) => ({ ...all, [name]: listed }));
    } catch (error) {
      this.collections.update(({ [name]: _, ...rest }) => rest);
      explorer.fail(error);
    }
  }
  listed(name: string): CollectionSummary[] {
    const listed = this.collections()[name];
    return Array.isArray(listed) ? listed : [];
  }
  kindLabel(collection: CollectionSummary) {
    if (collection.gridfs) return 'GridFS';
    if (collection.kind === 'view') return 'View';
    if (collection.kind === 'timeseries') return 'Time series';
    if (collection.name.startsWith('system.')) return 'System';
    return '';
  }
  async loadStats() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target) return;
    try {
      const stats = await explorer.use((cases) =>
        cases.connections.stats(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
        ),
      );
      if (explorer.target() === target) this.stats.set(stats);
    } catch {
      // Some servers and time series collections have no statistics: the query still works.
    }
  }
}
