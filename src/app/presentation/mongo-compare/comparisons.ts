import { Injector, computed, inject, signal } from '@angular/core';
import { WorkspaceDocument } from '../../domain/models';
import { compareValue } from '../../domain/mongo-compare';
import type { MongoExplorer } from '../mongo-explorer';
import { named } from '../workspace-state';
import { Comparison } from './comparison';

/** The comparisons of the explorer: the dialog, its runs and the comparisons saved. */
export class MongoComparisons {
  readonly draft = signal<Comparison | undefined>(undefined);
  readonly savedId = signal('');
  readonly saved = computed(() =>
    this.explorer.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'mongo-compare' &&
          compareValue(d.value).connection === this.explorer.connection().id,
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  private readonly injector = inject(Injector);

  constructor(private readonly explorer: MongoExplorer) {}

  /** Compares the collection shown with another one, of this connection by default. */
  open() {
    const target = this.explorer.target();
    if (!target) return;
    const stored = compareValue({
      connection: this.explorer.connection().id,
      database: target.database,
      collection: target.collection,
      target: {
        connection: this.explorer.connection().id,
        database: target.database,
        collection: '',
      },
    });
    this.savedId.set('');
    this.draft.set(new Comparison(this.explorer, this.injector, stored));
  }
  async openSaved(document: WorkspaceDocument) {
    const value = compareValue(document.value);
    await this.explorer.openCollection(value.database, value.collection);
    this.savedId.set(document.id);
    this.draft.set(new Comparison(this.explorer, this.injector, value, document.name));
  }
  close() {
    void this.cancel();
    this.draft.set(undefined);
  }
  async cancel() {
    const draft = this.draft();
    if (!draft?.running) return;
    const { explorer } = this;
    await explorer
      .use((cases) => cases.queries.cancel(explorer.state.workspaceId(), draft.running))
      .catch(() => undefined);
  }

  async run(draft: Comparison) {
    const { explorer } = this;
    const source = draft.source();
    const target = draft.target();
    if (!source || !target) return draft.error.set('Choose the collection to compare with');
    let rules;
    try {
      rules = draft.rules();
    } catch {
      return draft.error.set('The filter cannot be read');
    }
    draft.error.set('');
    draft.phase.set('running');
    draft.running = crypto.randomUUID();
    try {
      const result = await explorer.use((cases) =>
        cases.compare.compare(
          explorer.state.workspaceId(),
          explorer.state.scopes(),
          source,
          target,
          rules,
          draft.running,
        ),
      );
      draft.result.set(result);
      draft.chosen.set(-1);
      draft.phase.set('done');
    } catch (error) {
      draft.error.set(explorer.state.describe(error));
      draft.phase.set(draft.result() ? 'done' : 'setup');
    } finally {
      draft.running = '';
    }
  }
  /** Makes the target like the source, then compares again. */
  async sync(draft: Comparison) {
    const { explorer } = this;
    const source = draft.source();
    const target = draft.target();
    const m = draft.model();
    if (!source || !target) return;
    if (m.confirm.trim() !== target.collection)
      return draft.error.set('Type the name of the target collection to sync it');
    draft.error.set('');
    draft.phase.set('running');
    draft.running = crypto.randomUUID();
    try {
      const synced = await explorer.use((cases) =>
        cases.compare.sync(
          explorer.state.workspaceId(),
          explorer.state.scopes(),
          source,
          target,
          draft.rules(),
          m.remove,
          m.confirm.trim(),
          draft.running,
        ),
      );
      draft.synced.set(synced);
      draft.model.update((model) => ({ ...model, confirm: '' }));
    } catch (error) {
      draft.error.set(explorer.state.describe(error));
      draft.phase.set('done');
      return;
    } finally {
      draft.running = '';
    }
    await this.run(draft);
  }

  async save(draft: Comparison) {
    const { explorer } = this;
    await explorer.state.announce('The comparison could not be saved', async () => {
      const existing = explorer.state.documents().find((d) => d.id === this.savedId());
      const value = draft.value();
      const name = draft.model().name.trim() || `${value.collection} ↔ ${value.target.collection}`;
      const saved = await explorer.use((cases) =>
        cases.compare.save(
          explorer.state.workspaceId(),
          name,
          value,
          existing,
          crypto.randomUUID(),
        ),
      );
      explorer.state.applySaved([saved]);
      this.savedId.set(saved.id);
      draft.model.update((model) => ({ ...model, name: saved.name }));
      return named('Comparison saved', saved.name);
    });
  }
  async remove(document: WorkspaceDocument) {
    const { explorer } = this;
    if (!explorer.state.confirm('Delete this saved comparison?')) return;
    await explorer.state.announce('The comparison could not be deleted', async () => {
      await explorer.use((cases) => cases.compare.remove(document));
      explorer.state.forget(document);
      if (this.savedId() === document.id) this.savedId.set('');
      return named('Comparison deleted', document.name);
    });
  }
}
