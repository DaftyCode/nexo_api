import { computed, signal } from '@angular/core';
import { BuiltQuery } from '../../domain/mongo-query';
import type { QueryTarget } from '../../application/mongo-use-cases';
import type { MongoExplorer } from '../mongo-explorer';

/** A page of results already read, and where it starts. */
export interface Page {
  offset: number;
  documents: Record<string, unknown>[];
  truncated: boolean;
  elapsedMs: number;
}

/** Pages kept to go back without asking the server again. */
const KEPT_PAGES = 5;

/** The query of the bar: its pages read through an open cursor, its count and cancelling. */
export class MongoPager {
  /** The query whose pages are shown, as it was sent. */
  private ran: { target: QueryTarget; query: BuiltQuery; pageSize: number } | undefined;
  readonly pages = signal<Page[]>([]);
  readonly page = signal(0);
  /** The open cursor after the newest page read. */
  private readonly cursor = signal<string | undefined>(undefined);
  readonly running = signal<string | undefined>(undefined);
  readonly total = signal<number | undefined>(undefined);
  readonly current = computed<Page | undefined>(() => this.pages()[this.page()]);
  readonly hasNext = computed(() => {
    const pages = this.pages();
    return this.page() < pages.length - 1 || (this.page() === pages.length - 1 && !!this.cursor());
  });
  readonly hasPrevious = computed(
    () => (this.current()?.offset ?? 0) > (this.ran?.query.skip ?? 0) || this.page() > 0,
  );

  constructor(private readonly explorer: MongoExplorer) {}

  /** Runs the query and shows its first page. */
  async find(skipFrom?: number) {
    const { explorer } = this;
    const target = explorer.target();
    if (!target || this.running()) return;
    const query = explorer.query();
    if (!query) return;
    const pageSize = Number(explorer.model().pageSize) || 50;
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
    explorer.error.set('');
    try {
      const page = await explorer.use((cases) =>
        cases.queries.find(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
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
        void explorer.library.record(target);
      }
    } catch (error) {
      explorer.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }
  async next() {
    const pages = this.pages();
    const index = this.page();
    if (index < pages.length - 1) {
      this.page.set(index + 1);
      return;
    }
    const cursor = this.cursor();
    const current = pages[index];
    if (!cursor || !current || !this.ran || this.running()) return;
    const { explorer } = this;
    const id = crypto.randomUUID();
    this.running.set(id);
    explorer.error.set('');
    try {
      const page = await explorer.use((cases) =>
        cases.queries.more(explorer.state.workspaceId(), cursor, id, this.ran?.pageSize ?? 50),
      );
      const offset = current.offset + current.documents.length;
      this.pages.update((kept) => [...kept, { offset, ...page }].slice(-KEPT_PAGES));
      this.page.set(Math.min(index + 1, KEPT_PAGES - 1));
      this.cursor.set(page.cursor);
    } catch (error) {
      this.cursor.set(undefined);
      explorer.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }
  async previous() {
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
  async count() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target || this.running()) return;
    const query = explorer.query();
    if (!query) return;
    const id = crypto.randomUUID();
    this.running.set(id);
    explorer.error.set('');
    try {
      this.total.set(
        await explorer.use((cases) =>
          cases.queries.count(
            explorer.state.workspaceId(),
            explorer.connection(),
            explorer.state.scopes(),
            target,
            query,
            id,
          ),
        ),
      );
    } catch (error) {
      explorer.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }
  /** Cancels the query, count or explain that runs. */
  async cancel() {
    const id = this.running();
    if (!id) return;
    const { explorer } = this;
    try {
      await explorer.use((cases) => cases.queries.cancel(explorer.state.workspaceId(), id));
    } catch (error) {
      explorer.fail(error);
    }
  }
  closeCursor() {
    const cursor = this.cursor();
    this.cursor.set(undefined);
    const { explorer } = this;
    if (cursor)
      void explorer.use((cases) => cases.queries.close(explorer.state.workspaceId(), cursor));
  }
  reset() {
    this.closeCursor();
    this.pages.set([]);
    this.page.set(0);
    this.total.set(undefined);
    this.ran = undefined;
  }
}
