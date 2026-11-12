import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { shellText } from '../domain/bson';
import type { CompareResult, DifferenceKind } from '../application/mongo-use-cases';
import type { Comparison } from './mongo-compare/comparison';
import type { MongoComparisons } from './mongo-compare/comparisons';

const KIND_LABELS: Record<DifferenceKind, string> = {
  onlySource: 'Only in this collection',
  onlyTarget: 'Only in the other',
  different: 'Different',
};

/**
 * The comparison of the collection shown with another: its settings, the differences by
 * kind with the fields of the one chosen side by side, and the sync of the other collection.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-compare',
  styleUrls: [
    './mongo-dialog.scss',
    './mongo-explorer.scss',
    './mongo-transfer.scss',
    './mongo-schema.scss',
  ],
  templateUrl: './mongo-compare.html',
  host: { '(keydown.escape)': 'escape()' },
})
export class MongoCompare {
  readonly comparisons = input.required<MongoComparisons>();
  readonly draft = input.required<Comparison>();
  protected readonly labels = KIND_LABELS;
  protected readonly kinds = Object.keys(KIND_LABELS) as DifferenceKind[];
  protected readonly text = (value: unknown) =>
    value === undefined ? '—' : shellText(value).replace(/\s+/g, ' ');
  protected readonly chosen = computed<CompareResult['differences'][number] | undefined>(
    () => this.draft().differences()[this.draft().chosen()],
  );

  protected escape() {
    if (this.draft().phase() !== 'running') this.comparisons().close();
  }
  protected count(kind: DifferenceKind | 'equal') {
    return this.draft().result()?.counts[kind] ?? 0;
  }
  /** What a sync would write, from the last comparison. */
  protected preview() {
    const remove = this.draft().model().remove;
    return {
      v0: this.count('onlySource'),
      v1: this.count('different'),
      v2: remove ? this.count('onlyTarget') : 0,
    };
  }
}
