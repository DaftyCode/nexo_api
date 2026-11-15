import { DecimalPipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { GridFormats } from '../../domain/db/grid/cells';
import { Group, calculate, groupRows } from '../../domain/db/grid/calc';
import { ResultColumn } from '../../domain/db/results';
import type { GroupingSource } from './data-grid';
import { ValueViewer } from './value-viewer';

export type PanelKind = 'none' | 'value' | 'meta' | 'calc' | 'group';

/**
 * The panels beside the grid, as DBeaver's: the active cell's whole value, the columns of
 * the result, figures of the selected cells, and the rows grouped by some columns (on the
 * server when the grid shows one table, otherwise over what was loaded, saying so).
 */
@Component({
  imports: [TranslocoPipe, DecimalPipe, ValueViewer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-panels',
  templateUrl: './grid-panels.html',
  styleUrl: './grid-panels.scss',
})
export class GridPanels {
  readonly kind = input.required<PanelKind>();
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly rows = input.required<readonly unknown[][]>();
  readonly active = input<{ row: number; column: number; value: unknown } | undefined>();
  readonly cells = input.required<{
    columns: readonly ResultColumn[];
    rows: readonly unknown[][];
  }>();
  readonly formats = input.required<GridFormats>();
  readonly grouping = input<GroupingSource | undefined>(undefined);
  readonly closed = output<void>();
  protected readonly figures = computed(() => calculate(this.cells().rows.flat()));
  /** The columns grouped by, by index. */
  protected readonly groupBy = signal<readonly number[]>([]);
  protected readonly serverGroups = signal<readonly Group[] | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly groups = computed(
    () => this.serverGroups() ?? groupRows(this.rows(), this.groupBy()).slice(0, 500),
  );

  protected title() {
    return `db.panel.${this.kind()}`;
  }

  protected toggleGroup(column: number) {
    this.serverGroups.set(undefined);
    this.groupBy.update((list) =>
      list.includes(column) ? list.filter((other) => other !== column) : [...list, column],
    );
  }
  /** A column dropped from the grid's header groups by it too. */
  protected dropped(event: DragEvent) {
    event.preventDefault();
    const name = event.dataTransfer?.getData('text/plain');
    const column = this.columns().findIndex((candidate) => candidate.name === name);
    if (column >= 0 && !this.groupBy().includes(column)) this.toggleGroup(column);
  }

  /** Groups the whole table on the server (`GROUP BY`), not only the rows loaded. */
  protected async groupOnServer() {
    const source = this.grouping();
    if (!source || !this.groupBy().length) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const names = this.groupBy().map((column) => this.columns()[column].name);
      this.serverGroups.set(await source(names));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
