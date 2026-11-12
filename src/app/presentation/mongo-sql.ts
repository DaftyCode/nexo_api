import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { shellText } from '../domain/bson';
import { SqlQuery } from '../application/mongo-use-cases';
import { CodeEditor } from './code-editor';
import type { MongoExplorer } from './mongo-explorer';

/**
 * SQL on a collection: a `SELECT` translated by the engine into the MongoDB query it stands
 * for, shown before anything runs, then opened (editable) in Documents or Aggregations.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-sql',
  styleUrl: './mongo-explorer.scss',
  styles: ':host { display: block; }',
  templateUrl: './mongo-sql.html',
})
export class MongoSql {
  readonly explorer = input.required<MongoExplorer>();
  protected readonly sql = signal('');
  protected readonly translated = signal<SqlQuery | undefined>(undefined);
  protected readonly problem = signal('');
  protected readonly running = signal(false);
  /** The MongoDB query, in the shell syntax. */
  protected readonly mongo = computed(() => {
    const query = this.translated();
    if (!query) return '';
    const target = `db.${query.collection}`;
    if (query.kind === 'aggregate') return `${target}.aggregate(${shellText(query.pipeline)})`;
    const { kind: _, collection: __, filter, projection, ...rest } = query;
    let text = `${target}.find(${shellText(filter ?? {})}${projection ? `, ${shellText(projection)}` : ''})`;
    for (const [name, value] of Object.entries(rest)) text += `.${name}(${shellText(value)})`;
    return text;
  });

  protected placeholder() {
    return `SELECT * FROM ${this.explorer().target()?.collection ?? 'orders'} WHERE status = 'A' LIMIT 20`;
  }
  protected change(text: string) {
    this.sql.set(text);
    this.translated.set(undefined);
    this.problem.set('');
  }
  async translate() {
    const explorer = this.explorer();
    if (!this.sql().trim()) return;
    this.running.set(true);
    this.problem.set('');
    try {
      this.translated.set(
        await explorer.use((cases) => cases.queries.sql(explorer.state.workspaceId(), this.sql())),
      );
    } catch (error) {
      this.translated.set(undefined);
      this.problem.set(explorer.state.describe(error));
    } finally {
      this.running.set(false);
    }
  }
  /** Opens the query in its tab, editable, and runs it there. */
  async open() {
    const query = this.translated();
    const explorer = this.explorer();
    const target = explorer.target();
    if (!query || !target) return;
    await explorer.openCollection(target.database, query.collection);
    if (query.kind === 'aggregate') {
      explorer.aggregations.load(query.pipeline);
      explorer.tab.set('aggregations');
      void explorer.aggregations.runner.run();
      return;
    }
    const text = (value: unknown) => (value === undefined ? '' : shellText(value));
    explorer.model.update((model) => ({
      ...model,
      filter: text(query.filter),
      projection: text(query.projection),
      sort: text(query.sort),
      skip: query.skip ? String(query.skip) : '',
      limit: query.limit ? String(query.limit) : '',
      collation: '',
      hint: '',
    }));
    explorer.moreOptions.set(!!(query.skip || query.limit));
    explorer.tab.set('documents');
    void explorer.pager.find();
  }
}
