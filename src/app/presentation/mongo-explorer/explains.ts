import { computed, signal } from '@angular/core';
import { Explainable } from '../../domain/mongo-indexes';
import type { ExplainedQuery, QueryTarget } from '../../application/mongo-use-cases';
import type { MongoExplorer } from '../mongo-explorer';

/** An explain shown, with what it explained. */
interface Explained {
  target: QueryTarget;
  query: ExplainedQuery;
  executed: boolean;
  result: unknown;
}

/** How the server runs a query: of the bar, or an operation the profiler recorded. */
export class MongoExplains {
  /** The last explain, of the query bar or of an operation the profiler recorded. */
  readonly shown = signal<Explained | undefined>(undefined);
  readonly pipeline = computed(() => {
    const explained = this.shown();
    return !!explained && 'pipeline' in explained.query;
  });

  constructor(private readonly explorer: MongoExplorer) {}

  /** How the server runs the query of the bar: run and measured, or only planned. */
  query(executed = true) {
    const target = this.explorer.target();
    if (!target) return;
    const query = this.explorer.query();
    if (!query) {
      this.explorer.tab.set('documents');
      return;
    }
    const { database, collection } = target;
    void this.run({ database, collection }, { query }, executed);
  }
  /** Explains again an operation the profiler recorded. */
  entry({ database, collection, query, pipeline }: Explainable) {
    void this.run({ database, collection }, pipeline ? { pipeline } : { query: query ?? {} }, true);
  }
  /** Explains again what is shown, measured or only planned. */
  again(executed: boolean) {
    const shown = this.shown();
    if (shown) void this.run(shown.target, shown.query, executed);
  }
  private async run(target: QueryTarget, query: ExplainedQuery, executed: boolean) {
    const { explorer } = this;
    const pager = explorer.pager;
    if (pager.running()) return;
    const id = crypto.randomUUID();
    pager.running.set(id);
    explorer.error.set('');
    explorer.tab.set('explain');
    try {
      const result = await explorer.use((cases) =>
        cases.tuning.explain(
          explorer.state.workspaceId(),
          explorer.connection(),
          explorer.state.scopes(),
          target,
          query,
          executed,
          id,
        ),
      );
      this.shown.set({ target, query, executed, result });
    } catch (error) {
      explorer.fail(error);
    } finally {
      pager.running.set(undefined);
    }
  }
}
