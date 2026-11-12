import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import type { BuiltAggregation } from '../../application/mongo-use-cases';
import { WorkspaceDocument } from '../../domain/models';
import {
  AggregationOptions,
  PipelineStage,
  STAGE_OPERATORS,
  StageError,
  aggregationValue,
  buildAggregationOptions,
  buildPipeline,
  emptyAggregationOptions,
  newStage,
  pipelineText,
  readingPipeline,
  stageDocument,
  stagesFromText,
  writes,
  writtenCollection,
} from '../../domain/mongo-aggregation';
import { resolveVariables } from '../../domain/variables';
import { shellText } from '../../domain/bson';
import type { MongoExplorer } from '../mongo-explorer';
import { named } from '../workspace-state';
import { AggregationRunner } from './runner';

/** What the Aggregations tab edits. */
export interface AggregationModel {
  stages: PipelineStage[];
  options: AggregationOptions;
  /** The operator of the next stage added. */
  adding: string;
  /** Documents in the preview of a stage. */
  previewLimit: string;
  /** The collection a `$out` or `$merge` writes, repeated to run it. */
  confirm: string;
  /** The whole pipeline as text, to paste or copy it. */
  text: string;
  name: string;
}

/** A stage, or the options (`stage: -1`), that cannot be used, and why. */
export interface StageProblem {
  stage: number;
  key: string;
  params: Record<string, unknown>;
}

export const PREVIEW_LIMITS = ['10', '20', '50'];

function emptyModel(): AggregationModel {
  return {
    stages: [newStage('$match')],
    options: emptyAggregationOptions(),
    adding: '$group',
    previewLimit: '10',
    confirm: '',
    text: '',
    name: '',
  };
}

/**
 * The pipeline of the Aggregations tab: its stages added, moved, turned off and removed, as
 * text, its options, and the aggregations saved for the connection.
 */
export class AggregationEditor {
  readonly operators = STAGE_OPERATORS;
  readonly model = signal<AggregationModel>(emptyModel());
  readonly fields;
  readonly problem = signal<StageProblem | undefined>(undefined);
  /** The pipeline is shown as text to copy it or paste another. */
  readonly textOpen = signal(false);
  readonly savedId = signal('');
  readonly saved = computed(() =>
    this.explorer.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'mongo-aggregation' &&
          aggregationValue(d.value).connection === this.explorer.connection().id,
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  /** The last stage that runs writes with `$out` or `$merge`. */
  readonly writing = computed(() => {
    const last = this.model()
      .stages.filter((stage) => stage.enabled)
      .at(-1);
    return !!last && writes(last);
  });
  /** The collection the writing stage names, to repeat it; `''` while it cannot be read. */
  readonly written = computed(() => {
    const stages = this.model().stages;
    const index = stages.map((stage) => stage.enabled).lastIndexOf(true);
    if (index < 0 || !writes(stages[index])) return '';
    try {
      return writtenCollection(stageDocument(stages[index], index, (t) => this.resolve(t)));
    } catch {
      return '';
    }
  });
  readonly runner: AggregationRunner;

  constructor(
    readonly explorer: MongoExplorer,
    injector: Injector,
  ) {
    this.fields = runInInjectionContext(injector, () => form(this.model));
    this.runner = new AggregationRunner(this);
  }

  private resolve(text: string) {
    return resolveVariables(text, this.explorer.state.scopes());
  }
  private stages(change: (stages: PipelineStage[]) => PipelineStage[]) {
    this.model.update((model) => ({ ...model, stages: change([...model.stages]), confirm: '' }));
    this.problem.set(undefined);
    this.runner.forget();
  }
  add() {
    this.stages((stages) => [...stages, newStage(this.model().adding)]);
  }
  remove(index: number) {
    this.stages((stages) => stages.filter((_, i) => i !== index));
  }
  move(index: number, offset: -1 | 1) {
    this.stages((stages) => {
      const to = index + offset;
      if (to < 0 || to >= stages.length) return stages;
      [stages[index], stages[to]] = [stages[to], stages[index]];
      return stages;
    });
  }

  /** Runs `work` and turns a stage that cannot be used into the problem shown. */
  attempt<T>(work: () => T): T | undefined {
    this.problem.set(undefined);
    try {
      return work();
    } catch (error) {
      if (!(error instanceof StageError)) throw error;
      this.problem.set({ stage: error.stage, key: error.key, params: error.params });
      return undefined;
    }
  }
  /** The pipeline that runs and its options, ready to send. */
  build(): BuiltAggregation | undefined {
    const { stages, options } = this.model();
    const resolve = (text: string) => this.resolve(text);
    return this.attempt(() => ({
      pipeline: buildPipeline(stages, resolve),
      options: buildAggregationOptions(options, resolve),
    }));
  }
  /** The options alone, for the preview of a stage. */
  options() {
    return this.attempt(() =>
      buildAggregationOptions(this.model().options, (text) => this.resolve(text)),
    );
  }
  /** How the server runs the pipeline, without the stage that writes. */
  explain() {
    const target = this.explorer.target();
    const built = this.build();
    if (!target || !built) return;
    const { collation, hint } = built.options;
    const { database, collection } = target;
    this.explorer.explains.aggregation(
      { database, collection },
      {
        pipeline: readingPipeline(built.pipeline),
        ...(collation ? { collation } : {}),
        ...(hint ? { hint } : {}),
      },
    );
  }
  /** Driver code for the pipeline, with its options. */
  showCode() {
    const target = this.explorer.target();
    const built = this.build();
    if (!target || !built) return;
    const { database, collection } = target;
    this.explorer.code.set({
      kind: 'aggregate',
      database,
      collection,
      pipeline: built.pipeline,
      ...built.options,
    });
  }
  /** Exports the results of the pipeline with the dialog of imports and exports. */
  export() {
    if (!this.build()) return;
    const { stages, options } = this.model();
    this.explorer.transfers.open('export', {
      pipeline: stages.map((stage) => ({ ...stage })),
      pipelineOptions: { ...options },
    });
  }

  openText() {
    this.model.update((model) => ({ ...model, text: pipelineText(model.stages) }));
    this.problem.set(undefined);
    this.textOpen.set(true);
  }
  /** Replaces the stages with those of the text. */
  applyText() {
    const stages = this.attempt(() => stagesFromText(this.model().text));
    if (!stages) return;
    this.stages(() => stages);
    this.textOpen.set(false);
  }

  /** Replaces the stages with those of a pipeline, such as one translated from SQL. */
  load(pipeline: readonly Record<string, unknown>[]) {
    this.savedId.set('');
    this.stages(() =>
      pipeline.map((stage) => {
        const [operator, value] = Object.entries(stage)[0] ?? ['$match', {}];
        return { operator, body: shellText(value), enabled: true };
      }),
    );
  }
  /** A new pipeline, with one `$match`. */
  clear() {
    this.savedId.set('');
    this.model.set(emptyModel());
    this.problem.set(undefined);
    this.textOpen.set(false);
    this.runner.reset();
  }
  async save() {
    const { explorer } = this;
    const target = explorer.target();
    if (!target) return;
    await explorer.state.announce('The aggregation could not be saved', async () => {
      const existing = explorer.state.documents().find((d) => d.id === this.savedId());
      const { stages, options, name } = this.model();
      const saved = await explorer.use((cases) =>
        cases.aggregations.save(
          explorer.state.workspaceId(),
          name,
          { connection: explorer.connection().id, ...target, stages, options },
          existing,
        ),
      );
      explorer.state.applySaved([saved]);
      this.savedId.set(saved.id);
      this.model.update((model) => ({ ...model, name: saved.name }));
      return named('Aggregation saved', saved.name);
    });
  }
  async removeSaved(document: WorkspaceDocument) {
    const { explorer } = this;
    if (!explorer.state.confirm('Delete this saved aggregation?')) return;
    await explorer.state.announce('The aggregation could not be deleted', async () => {
      await explorer.use((cases) => cases.aggregations.remove(document));
      explorer.state.forget(document);
      if (this.savedId() === document.id) this.savedId.set('');
      return named('Aggregation deleted', document.name);
    });
  }
  /** Opens a saved aggregation on its collection, in the Aggregations tab. */
  async open(document: WorkspaceDocument) {
    const { explorer } = this;
    const value = aggregationValue(document.value);
    await explorer.openCollection(value.database, value.collection);
    explorer.tab.set('aggregations');
    this.runner.reset();
    this.savedId.set(document.id);
    this.problem.set(undefined);
    this.model.update((model) => ({
      ...model,
      stages: value.stages.length ? value.stages : [newStage('$match')],
      options: value.options,
      confirm: '',
      name: document.name,
    }));
  }
}
