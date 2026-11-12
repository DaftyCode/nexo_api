import { computed, signal } from '@angular/core';
import type { AggregateWritten, BuiltAggregation } from '../../application/mongo-use-cases';
import { previewPipeline, writes } from '../../domain/mongo-aggregation';
import { resolveVariables } from '../../domain/variables';
import type { Page } from '../mongo-explorer/pager';
import type { AggregationEditor } from './editor';

/** What the preview of a stage shows: its first documents, why it failed, or that it writes. */
export interface StagePreview {
  documents?: Record<string, unknown>[];
  elapsedMs?: number;
  error?: string;
  writes?: boolean;
}

/** Pages of results kept to go back without running the pipeline again. */
const KEPT_PAGES = 5;

/**
 * Runs the pipeline of the Aggregations tab: the preview of each stage (never one that
 * writes), the whole pipeline with its pages, or the pipeline that writes, and cancels them.
 */
export class AggregationRunner {
  /** The previews shown, by the stage's position. */
  readonly previews = signal<ReadonlyMap<number, StagePreview>>(new Map());
  /** The stage being previewed, while it runs. */
  readonly previewing = signal<number | undefined>(undefined);
  readonly running = signal<string | undefined>(undefined);
  readonly pages = signal<Page[]>([]);
  readonly page = signal(0);
  private readonly cursor = signal<string | undefined>(undefined);
  private pageSize = 50;
  readonly current = computed<Page | undefined>(() => this.pages()[this.page()]);
  readonly hasNext = computed(() => {
    const pages = this.pages();
    return this.page() < pages.length - 1 || (this.page() === pages.length - 1 && !!this.cursor());
  });
  readonly hasPrevious = computed(() => this.page() > 0);
  /** What the last pipeline that writes did. */
  readonly written = signal<AggregateWritten | undefined>(undefined);

  constructor(private readonly editor: AggregationEditor) {}

  private get explorer() {
    return this.editor.explorer;
  }
  private set(index: number, preview: StagePreview | undefined) {
    this.previews.update((previews) => {
      const next = new Map(previews);
      if (preview) next.set(index, preview);
      else next.delete(index);
      return next;
    });
  }
  /** The stages moved or changed: their previews no longer match them. */
  forget() {
    this.previews.set(new Map());
  }

  /** The documents up to a stage, a few of them; a stage that writes is not run. */
  async preview(index: number) {
    const { explorer, editor } = this;
    const target = explorer.target();
    const stages = editor.model().stages;
    if (!target || this.running() || !stages[index]) return;
    if (writes(stages[index])) {
      this.set(index, { writes: true });
      return;
    }
    const limit = Number(editor.model().previewLimit) || 10;
    const resolve = (text: string) => resolveVariables(text, explorer.state.scopes());
    const pipeline = editor.attempt(() => previewPipeline(stages, index, limit, resolve));
    const options = pipeline && editor.options();
    if (!pipeline || !options) return this.set(index, undefined);
    const id = crypto.randomUUID();
    this.running.set(id);
    this.previewing.set(index);
    try {
      const page = await explorer.use((cases) =>
        cases.aggregations.aggregate(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
          { pipeline, options },
          id,
          limit,
        ),
      );
      if (page.cursor) this.close(page.cursor);
      this.set(index, { documents: page.documents, elapsedMs: page.elapsedMs });
    } catch (error) {
      this.set(index, { error: explorer.state.describe(error) });
    } finally {
      this.running.set(undefined);
      this.previewing.set(undefined);
    }
  }
  /** The preview of every stage, one after another, until one cannot be used. */
  async previewAll() {
    const count = this.editor.model().stages.length;
    for (let index = 0; index < count; index++) {
      await this.preview(index);
      if (this.editor.problem() || this.previews().get(index)?.error) return;
    }
  }

  /** Runs the whole pipeline: its first page, or the write of its last stage. */
  async run() {
    const { explorer, editor } = this;
    const target = explorer.target();
    if (!target || this.running()) return;
    const built = editor.build();
    if (!built) return;
    if (editor.writing()) return this.write(built);
    this.reset();
    const id = crypto.randomUUID();
    this.running.set(id);
    explorer.error.set('');
    this.pageSize = Number(explorer.model().pageSize) || 50;
    try {
      const page = await explorer.use((cases) =>
        cases.aggregations.aggregate(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
          built,
          id,
          this.pageSize,
        ),
      );
      this.pages.set([{ offset: 0, ...page }]);
      this.cursor.set(page.cursor);
    } catch (error) {
      explorer.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }
  /** Runs a pipeline that writes, once the collection it writes is named again. */
  private async write(built: BuiltAggregation) {
    const { explorer, editor } = this;
    const target = explorer.target()!;
    const confirm = editor.model().confirm.trim();
    if (!explorer.writable()) return explorer.error.set('This connection is read-only');
    if (!confirm || confirm !== editor.written())
      return editor.problem.set({
        stage: -1,
        key: 'Type the name of the collection the pipeline writes',
        params: {},
      });
    this.reset();
    const id = crypto.randomUUID();
    this.running.set(id);
    explorer.error.set('');
    try {
      const written = await explorer.use((cases) =>
        cases.aggregations.write(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
          built,
          confirm,
          id,
        ),
      );
      this.written.set(written);
      editor.model.update((model) => ({ ...model, confirm: '' }));
      // The collection written may be new, in a database that may be new too.
      void explorer.browser.loadDatabases();
    } catch (error) {
      explorer.fail(error);
    } finally {
      this.running.set(undefined);
    }
  }
  async next() {
    const pages = this.pages();
    const index = this.page();
    if (index < pages.length - 1) return this.page.set(index + 1);
    const cursor = this.cursor();
    const current = pages[index];
    if (!cursor || !current || this.running()) return;
    const { explorer } = this;
    const id = crypto.randomUUID();
    this.running.set(id);
    try {
      const page = await explorer.use((cases) =>
        cases.queries.more(explorer.state.workspaceId(), cursor, id, this.pageSize),
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
  previous() {
    if (this.page() > 0) this.page.update((page) => page - 1);
  }
  /** Cancels the preview or the pipeline that runs. */
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
  private close(cursor: string) {
    const { explorer } = this;
    void explorer.use((cases) => cases.queries.close(explorer.state.workspaceId(), cursor));
  }
  /** Forgets the results and the previews, closing the open cursor. */
  reset() {
    const cursor = this.cursor();
    this.cursor.set(undefined);
    if (cursor) this.close(cursor);
    this.pages.set([]);
    this.page.set(0);
    this.written.set(undefined);
    this.forget();
  }
}
