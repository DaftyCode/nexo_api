import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { DifferenceKind, differenceKind, valueText } from '../../domain/response-compare';

/** The difference a value has, as it is said. */
const KIND_LABELS: Record<DifferenceKind, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

/** A field or item and its value on each side; a side without it has no value. */
export interface ShownDifference {
  path: string;
  source?: unknown;
  target?: unknown;
}

/**
 * The fields that differ between two documents, one per row: where, what happened to it
 * (only in the second, only in the first, or changed) and its value on each side. Used to
 * compare responses and collections of MongoDB.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-field-differences',
  template: `
    <div class="table-scroll">
      <table class="data-table" [attr.aria-label]="caption()">
        <thead>
          <tr>
            <th scope="col">{{ pathLabel() }}</th>
            <th scope="col">{{ 'Change' | transloco }}</th>
            <th scope="col">{{ sourceLabel() }}</th>
            <th scope="col">{{ targetLabel() }}</th>
          </tr>
        </thead>
        <tbody>
          @for (difference of differences(); track $index) {
            <tr>
              <th scope="row">
                <code>{{ difference.path }}</code>
              </th>
              <td>
                <span class="status-pill" [class]="kind(difference)">{{
                  labels[kind(difference)] | transloco
                }}</span>
              </td>
              <td>{{ shown(difference.source) }}</td>
              <td>{{ shown(difference.target) }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    th[scope='row'] {
      font-weight: var(--nexo-font-weight-regular);
      background: none;
    }
    td {
      overflow-wrap: anywhere;
    }
  `,
})
export class FieldDifferences {
  readonly differences = input.required<readonly ShownDifference[]>();
  readonly sourceLabel = input.required<string>();
  readonly targetLabel = input.required<string>();
  /** The accessible name of the table. */
  readonly caption = input.required<string>();
  /** The heading of the first column: a field, a path, a header. */
  readonly pathLabel = input.required<string>();
  /** How a value is written; JSON in one line by default. */
  readonly format = input<(value: unknown) => string>((value) => valueText(value));
  protected readonly labels = KIND_LABELS;
  protected readonly kind = differenceKind;

  protected shown(value: unknown) {
    return value === undefined ? '—' : this.format()(value);
  }
}
