import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ResultColumn } from '../../domain/db/results';

/** The «Metadata» of a result: each column with its type, nullability, key and origin. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-result-meta',
  template: `
    <table class="db-plain">
      <thead>
        <tr>
          <th scope="col">{{ 'Column' | transloco }}</th>
          <th scope="col">{{ 'Type' | transloco }}</th>
          <th scope="col">{{ 'Nullable' | transloco }}</th>
          <th scope="col">{{ 'Key' | transloco }}</th>
          <th scope="col">{{ 'Origin' | transloco }}</th>
        </tr>
      </thead>
      <tbody>
        @for (column of columns(); track $index) {
          <tr>
            <td>{{ column.name }}</td>
            <td>{{ column.typeName }}</td>
            <td>
              {{
                column.nullable === undefined ? '—' : ((column.nullable ? 'Yes' : 'No') | transloco)
              }}
            </td>
            <td>{{ (column.key ? 'Yes' : 'No') | transloco }}</td>
            <td>
              {{ column.origin?.table ?? '' }}{{ column.origin?.column ? '.' : ''
              }}{{ column.origin?.column ?? '' }}
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class DbResultMeta {
  readonly columns = input.required<readonly ResultColumn[]>();
}
