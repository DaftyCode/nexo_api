import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { QueryModel } from '../../domain/db/query-model';
import type { BuilderLayout } from '../../domain/db/query-model/layout';

/** A column being dragged to another, to join them. */
const COLUMN_DRAG = 'application/x-nexo-column';
interface ColumnAt {
  table: number;
  expression: string;
}

/**
 * The canvas of the visual query builder: each table with its columns, a box to choose each
 * one, and the line of each join with a button that changes its kind. Dragging a column onto
 * one of another table joins them. Everything here can also be done from the panels.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-query-canvas',
  template: `
    @let laid = layout();
    <div class="qb-canvas" [style.width.px]="laid.width" [style.height.px]="laid.height">
      <svg
        class="qb-lines"
        [attr.width]="laid.width"
        [attr.height]="laid.height"
        aria-hidden="true"
      >
        @for (line of laid.lines; track $index) {
          <line
            [attr.x1]="line.x1"
            [attr.y1]="line.y1"
            [attr.x2]="line.x2"
            [attr.y2]="line.y2"
            [class.qb-outer]="line.kind !== 'inner'"
          />
        }
      </svg>
      @for (line of laid.lines; track $index) {
        <button
          type="button"
          class="qb-join"
          [style.left.px]="(line.x1 + line.x2) / 2"
          [style.top.px]="(line.y1 + line.y2) / 2"
          [disabled]="readOnly()"
          [attr.aria-label]="
            'db.builder.kind' | transloco: { v0: aliasOf(line.table), v1: line.kind.toUpperCase() }
          "
          (click)="kind.emit(line.table)"
        >
          {{ line.kind.toUpperCase() }}
        </button>
      }
      @for (table of laid.tables; track table.index) {
        <div
          class="qb-table"
          role="group"
          [attr.aria-label]="table.label"
          [style.left.px]="table.x"
          [style.top.px]="table.y"
          [style.width.px]="table.width"
          [style.height.px]="table.height"
        >
          <div class="qb-head">
            <strong class="grow qb-name" [attr.title]="table.label">{{ table.label }}</strong>
            <span class="muted">{{ table.alias }}</span>
            <button
              type="button"
              class="icon-button"
              [disabled]="readOnly()"
              [attr.aria-label]="'db.builder.remove' | transloco: { v0: table.label }"
              (click)="removed.emit(table.index)"
            >
              ×
            </button>
          </div>
          @for (column of table.columns; track column.name) {
            <label
              class="qb-column"
              [draggable]="!readOnly()"
              (dragstart)="start($event, { table: table.index, expression: column.expression })"
              (dragover)="over($event)"
              (drop)="drop($event, { table: table.index, expression: column.expression })"
              ><input
                type="checkbox"
                [checked]="chosen().has(column.expression)"
                [disabled]="readOnly()"
                (change)="toggled.emit(column.expression)"
              />{{ column.name }}</label
            >
          }
        </div>
      }
    </div>
  `,
  styleUrl: './canvas.scss',
})
export class DbQueryCanvas {
  readonly layout = input.required<BuilderLayout>();
  readonly model = input.required<QueryModel>();
  readonly readOnly = input(false);
  readonly toggled = output<string>();
  readonly joined = output<{ from: ColumnAt; to: ColumnAt }>();
  readonly kind = output<number>();
  readonly removed = output<number>();
  protected readonly chosen = computed(
    () => new Set(this.model().columns.map((column) => column.expression)),
  );

  protected aliasOf(table: number) {
    return this.layout().tables[table]?.label ?? '';
  }
  protected start(event: DragEvent, column: ColumnAt) {
    event.dataTransfer?.setData(COLUMN_DRAG, JSON.stringify(column));
  }
  protected over(event: DragEvent) {
    if (event.dataTransfer?.types.includes(COLUMN_DRAG)) event.preventDefault();
  }
  protected drop(event: DragEvent, to: ColumnAt) {
    const data = event.dataTransfer?.getData(COLUMN_DRAG);
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    this.joined.emit({ from: JSON.parse(data) as ColumnAt, to });
  }
}
