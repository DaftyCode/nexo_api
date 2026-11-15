import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { GridFormats, formatCell } from '../../domain/db/grid/cells';
import { ResultColumn } from '../../domain/db/results';

/** The record view of a grid: one row upright, each field with its value, and the rows beside. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-record',
  template: `
    <section class="grid-record" [attr.aria-label]="'Record' | transloco">
      <div class="row">
        <button type="button" class="button small" (click)="moved.emit(-1)">
          {{ 'Previous' | transloco }}
        </button>
        <span>{{ 'db.grid.record' | transloco: { v0: position() + 1, v1: count() } }}</span>
        <button type="button" class="button small" (click)="moved.emit(1)">
          {{ 'Next' | transloco }}
        </button>
      </div>
      @if (row() !== undefined) {
        <dl tabindex="0">
          @for (column of order(); track column) {
            @let shown = cell(column);
            <dt>{{ columns()[column].name }}</dt>
            <dd [class]="'grid-' + shown.kind">{{ shown.text }}</dd>
          }
        </dl>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .row {
      align-items: center;
      gap: var(--nexo-space-4);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--nexo-space-1) var(--nexo-space-6);
      font-size: var(--nexo-font-size-sm);
    }
    dt {
      color: var(--nexo-color-text-muted);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--nexo-font-mono);
    }
    .grid-null {
      color: var(--nexo-grid-null);
      font-style: italic;
    }
  `,
})
export class GridRecord {
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly order = input.required<readonly number[]>();
  /** The row shown, by its index among the rows loaded. */
  readonly row = input<number | undefined>();
  /** Its place among the rows shown, from 0, and how many there are. */
  readonly position = input(0);
  readonly count = input(0);
  readonly values = input.required<readonly unknown[][]>();
  readonly formats = input.required<GridFormats>();
  readonly moved = output<-1 | 1>();

  protected cell(column: number) {
    const row = this.row();
    return formatCell(row === undefined ? undefined : this.values()[row]?.[column], this.formats());
  }
}
