import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { MongoAggregationStage } from './mongo-aggregation-stage';
import { MongoResults } from './mongo-results';
import { PREVIEW_LIMITS } from './mongo-aggregations/editor';
import type { MongoExplorer } from './mongo-explorer';

/**
 * The Aggregations tab of a collection: the pipeline built stage by stage with the preview
 * of each, its options, the whole pipeline run with its pages (or written with `$out` or
 * `$merge` once confirmed), explained, exported and saved.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoAggregationStage, MongoResults],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-aggregations',
  styleUrls: ['./mongo-explorer.scss', './mongo-aggregations.scss'],
  templateUrl: './mongo-aggregations.html',
})
export class MongoAggregations {
  readonly explorer = input.required<MongoExplorer>();
  protected readonly editor = computed(() => this.explorer().aggregations);
  protected readonly runner = computed(() => this.editor().runner);
  protected readonly previewLimits = PREVIEW_LIMITS;
  /** A problem of the options or of the whole pipeline, not of one stage. */
  protected readonly problem = computed(() => {
    const problem = this.editor().problem();
    return problem && problem.stage < 0 ? problem : undefined;
  });
}
