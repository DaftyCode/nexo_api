import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { MongoResults } from './mongo-results';
import { PipelineStage, writes } from '../domain/mongo-aggregation';
import type { AggregationEditor } from './mongo-aggregations/editor';

/**
 * A stage of the pipeline: its operator and value, turned on or off, moved or removed, and
 * the first documents up to it. A stage that writes is marked and never previewed.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoResults],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-aggregation-stage',
  styleUrls: ['./mongo-explorer.scss', './mongo-aggregations.scss'],
  templateUrl: './mongo-aggregation-stage.html',
})
export class MongoAggregationStage {
  readonly editor = input.required<AggregationEditor>();
  readonly field = input.required<FieldTree<PipelineStage>>();
  readonly index = input.required<number>();
  readonly count = input.required<number>();

  protected readonly stage = computed<PipelineStage | undefined>(
    () => this.editor().model().stages[this.index()],
  );
  protected readonly writes = computed(() => {
    const stage = this.stage();
    return !!stage && writes(stage);
  });
  protected readonly preview = computed(() => this.editor().runner.previews().get(this.index()));
  protected readonly problem = computed(() => {
    const problem = this.editor().problem();
    return problem?.stage === this.index() ? problem : undefined;
  });
  protected readonly label = computed(() => `${this.index() + 1} ${this.stage()?.operator ?? ''}`);
}
