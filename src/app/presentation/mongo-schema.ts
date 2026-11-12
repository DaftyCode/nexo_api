import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { SAMPLE_SIZES, percent, presence, valueText } from '../domain/mongo-schema';
import type { MongoExplorer } from './mongo-explorer';

/**
 * The Schema tab of a collection: the fields of a sample with their presence, types and
 * anomalies, each opened to its frequent values (which open the documents that have them)
 * and ranges; the schema exported, and its validation rules applied to the collection.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-schema',
  styleUrls: ['./mongo-explorer.scss', './mongo-schema.scss'],
  templateUrl: './mongo-schema.html',
})
export class MongoSchema {
  readonly explorer = input.required<MongoExplorer>();
  protected readonly schema = computed(() => this.explorer().schema);
  protected readonly sizes = SAMPLE_SIZES;
  protected readonly percent = percent;
  protected readonly presence = presence;
  protected readonly valueText = valueText;
  /** The fields that look wrong, to list them first. */
  protected readonly anomalies = computed(() =>
    (this.schema().report()?.fields ?? []).filter((field) => field.anomalies.length),
  );
  /** Validation rules belong to collections, not to views or time series. */
  protected readonly validates = computed(
    () => this.explorer().writable() && this.explorer().target()?.kind === 'collection',
  );

  protected average(value: number) {
    return Math.round(value * 10) / 10;
  }
}
