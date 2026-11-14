import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ResultColumn, cellText, isNull } from '../domain/db/results';

/**
 * The rows of a result as a plain table, each value as its text and `NULL` set apart. The
 * data grid of DB-07 replaces it.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-result-table',
  template: `
    <table class="db-result-table">
      <thead>
        <tr>
          <th scope="col" class="db-row-number">#</th>
          @for (column of columns(); track $index) {
            <th scope="col" [attr.title]="column.typeName">{{ column.name }}</th>
          }
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track $index; let index = $index) {
          <tr>
            <th scope="row" class="db-row-number">{{ index + 1 }}</th>
            @for (value of row; track $index) {
              <td [class.db-null]="isNull(value)">{{ cellText(value) }}</td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    .db-result-table {
      border-collapse: collapse;
      font-family: var(--nexo-font-mono);
      font-size: var(--nexo-font-size-xs);
    }
    th,
    td {
      max-width: calc(var(--nexo-size-unit) * 120);
      padding: var(--nexo-space-1) var(--nexo-space-4);
      overflow: hidden;
      border: var(--nexo-border-width) solid var(--nexo-color-border-subtle);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--nexo-color-surface-2);
    }
    .db-row-number {
      color: var(--nexo-color-text-muted);
      font-weight: var(--nexo-font-weight-regular);
    }
    .db-null {
      color: var(--nexo-color-text-muted);
      font-style: italic;
    }
  `,
})
export class DbResultTable {
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly rows = input.required<readonly unknown[][]>();
  protected readonly cellText = cellText;
  protected readonly isNull = isNull;
}
