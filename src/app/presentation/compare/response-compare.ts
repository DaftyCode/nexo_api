import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TranslocoPipe } from '@jsverse/transloco';
import { ResponseComparison, StatusSide } from '../../domain/response-compare';
import { DiffView } from '../diff/diff-view';
import { FieldDifferences, ShownDifference } from '../diff/field-differences';
import { CompareSide } from './compare-side';
import { CompareStore } from './compare-store';

/**
 * Compares two responses: chosen from the tabs, the history or a collection run, or the
 * request of the tab sent with two environments. It shows what changed in the status, the
 * headers and the body (field by field when both are JSON) and both bodies side by side.
 */
@Component({
  imports: [TranslocoPipe, FormField, CompareSide, FieldDifferences, DiffView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-response-compare',
  templateUrl: './response-compare.html',
  styleUrl: './response-compare.scss',
})
export class ResponseCompare {
  protected readonly store = inject(CompareStore);

  protected headers(result: ResponseComparison): ShownDifference[] {
    return result.headers.map(({ name, source, target }) => ({ path: name, source, target }));
  }
  protected status(side: StatusSide) {
    return `${side.status || 'ERR'} ${side.statusText}`.trim();
  }
  /** Text bodies that look like markup are coloured as XML. */
  protected language(result: ResponseComparison) {
    if (result.body.format === 'json') return 'json';
    return /^\s*</.test(result.body.source ?? '') ? 'xml' : 'text';
  }
}
