import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { GridFormats, formatCell } from '../../domain/db/grid/cells';
import { CopyFormat, SqlStyle, copyAs } from '../../domain/db/grid/copy';
import {
  GridSelection,
  clickSelection,
  isSelected,
  moveSelection,
  selectedRange,
  startSelection,
} from '../../domain/db/grid/selection';
import { plainText } from '../../domain/db/grid/text';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { ResultColumn } from '../../domain/db/results';
import { GridColumns } from './columns';
import { GridFind } from './find';
import { GridPanels, PanelKind } from './grid-panels';
import { GridLayout } from './layout';
import { GridMenu } from './grid-menu';
import { GridRecord } from './grid-record';
import { GridFormatsState } from './formats';
import { GridPointer } from './pointer';
import { CellAction, GroupingSource } from './types';

export type { CellAction, GroupingSource } from './types';

let grids = 0;

/**
 * The data grid of the database section, as DBeaver's: virtualized in rows and columns (only
 * what is in sight is drawn), a WAI-ARIA grid for the keyboard, cells formatted by class,
 * columns resized, fitted, moved, hidden and pinned, order and filter over what was loaded,
 * find, record view, copy in several formats, a plain text view, and side panels.
 */
@Component({
  imports: [TranslocoPipe, FormField, NgTemplateOutlet, GridPanels, GridMenu, GridRecord],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-data-grid',
  templateUrl: './data-grid.html',
  styleUrl: './data-grid.scss',
})
export class DataGrid {
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly rows = input.required<readonly unknown[][]>();
  /** More rows can be read after these. */
  readonly more = input(false);
  readonly loading = input(false);
  readonly label = input('Rows');
  /** How the engine writes SQL, to copy as `IN` and `INSERT`. */
  readonly sql = input<SqlStyle | undefined>(undefined);
  /** The formats of Settings, unless the screen gives others. */
  readonly formats = input<GridFormats | undefined>(undefined);
  private readonly chosen = inject(GridFormatsState);
  protected readonly format = computed(() => this.formats() ?? this.chosen.formats());
  readonly grouping = input<GroupingSource | undefined>(undefined);
  readonly cellActions = input<readonly CellAction[]>([]);
  readonly view = model<GridView>(emptyView());
  readonly needMore = output<void>();
  readonly readAll = output<void>();
  readonly cellAction = output<{ action: string; column: number; value: unknown }>();
  /** The row the person is on, by its index among the rows loaded. */
  readonly activeRow = output<number>();

  protected readonly id = `grid-${++grids}`;
  protected readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  protected readonly selection = signal<GridSelection>(startSelection());
  protected readonly panel = signal<PanelKind>('none');
  protected readonly recordView = signal(false);
  protected readonly textView = signal(false);
  protected readonly menu = signal(false);
  protected readonly bar = signal({ filter: '', find: '', copy: 'text' as CopyFormat });
  protected readonly barFields = form(this.bar);
  protected readonly layout = new GridLayout({
    columns: () => this.columns(),
    rows: () => this.rows(),
    view: () => this.view(),
    filter: () => this.bar().filter,
  });
  protected readonly find = new GridFind(
    () => this.bar().find,
    () => this.rows(),
    () => this.layout.shown(),
    () => this.layout.order(),
  );
  protected readonly columnTools = new GridColumns(
    this.view,
    () => this.columns().length,
    (column) => this.layout.fitted(this.columns()[column], column),
  );
  protected readonly pointer = new GridPointer(this.columnTools, (column) =>
    this.layout.widthOf(column),
  );
  /** The active cell: its row among those loaded, its column, its value. */
  protected readonly active = computed(() => {
    const { row, column } = this.selection().active;
    const index = this.layout.shown()[row];
    const at = this.layout.order()[column];
    return index === undefined || at === undefined
      ? undefined
      : { row: index, column: at, value: this.rows()[index][at] };
  });
  protected readonly text = computed(() =>
    this.textView()
      ? plainText(
          this.columns(),
          this.rows(),
          this.layout.order(),
          this.layout.shown(),
          this.format(),
        )
      : '',
  );
  private asked = -1;

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.viewport()?.nativeElement;
      if (!element) return;
      this.layout.measure(element);
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => this.layout.read(element));
        observer.observe(element);
        destroy.onDestroy(() => observer.disconnect());
      }
      requestAnimationFrame(() => this.layout.measure(element));
    });
    // Near the end of what was read, the next page is asked for, once per page.
    effect(() => {
      const { last } = this.layout.rowsInSight();
      const count = this.rows().length;
      const near = last >= this.layout.shown().length - 10;
      if (!this.more() || this.loading() || !near || this.asked === count) return;
      this.asked = count;
      untracked(() => this.needMore.emit());
    });
    effect(() => {
      const active = this.active();
      if (active) untracked(() => this.activeRow.emit(active.row));
    });
  }

  protected cell(row: number, column: number) {
    return formatCell(this.rows()[row]?.[column], this.format());
  }
  protected cellId(position: number, column: number) {
    return `${this.id}-${position}-${column}`;
  }
  protected activeId() {
    const { row, column } = this.selection().active;
    return this.layout.shown().length ? this.cellId(row, column) : null;
  }
  protected selected(position: number, column: number) {
    const rows = this.layout.shown().length;
    return isSelected(this.selection(), rows, this.layout.order().length, position, column);
  }
  protected sortOf(column: number) {
    const sort = this.view().sort;
    return sort?.column !== column ? 'none' : sort.descending ? 'descending' : 'ascending';
  }

  protected scrolled() {
    const element = this.viewport()?.nativeElement;
    if (element) this.layout.read(element);
  }
  private reveal() {
    const element = this.viewport()?.nativeElement;
    if (element) this.layout.reveal(element, this.selection().active);
  }

  protected select(
    position: number,
    column: number,
    event: MouseEvent,
    mode: GridSelection['mode'] = 'cells',
  ) {
    const target = { row: position, column };
    this.selection.set(clickSelection(this.selection(), target, mode, event.shiftKey));
    this.viewport()?.nativeElement.focus({ preventScroll: true });
  }

  protected key(event: KeyboardEvent) {
    const ctrl = event.ctrlKey || event.metaKey;
    const letter = event.key.toLowerCase();
    if (ctrl && letter === 'c') return this.copy(event, 'text');
    if (ctrl && letter === 'a') {
      event.preventDefault();
      const end = { row: this.layout.shown().length - 1, column: this.layout.order().length - 1 };
      return this.selection.set({ active: end, anchor: { row: 0, column: 0 }, mode: 'cells' });
    }
    if (ctrl && letter === 'f') {
      event.preventDefault();
      return this.find.open.set(true);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return this.panel.set('value');
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      return this.menu.set(true);
    }
    const moved = moveSelection(this.selection(), event.key, {
      rows: this.layout.shown().length,
      columns: this.layout.order().length,
      page: this.layout.page(),
      ctrl,
      extend: event.shiftKey,
    });
    if (!moved) return;
    event.preventDefault();
    this.selection.set(moved);
    this.reveal();
  }

  /** The cells of the selection, in the order shown. */
  protected selectedCells() {
    const { shown, order } = this.layout;
    const range = selectedRange(this.selection(), shown().length, order().length);
    const columns = order().slice(range.left, range.right + 1);
    const rows = shown()
      .slice(range.top, range.bottom + 1)
      .map((index) => columns.map((column) => this.rows()[index][column]));
    return { columns: columns.map((column) => this.columns()[column]), rows };
  }

  protected copy(event: Event | undefined, format: CopyFormat) {
    event?.preventDefault();
    const text = copyAs(this.selectedCells(), format, this.sql());
    void globalThis.navigator?.clipboard?.writeText(text);
  }

  protected findNext(back = false) {
    const target = this.find.next(this.selection().active, back);
    if (!target) return;
    this.selection.set({ active: target, anchor: target, mode: 'cells' });
    this.reveal();
  }

  /** The record view goes to the row before or after. */
  protected step(by: -1 | 1) {
    const last = this.layout.shown().length - 1;
    const row = Math.min(Math.max(this.selection().active.row + by, 0), last);
    const active = { row, column: this.selection().active.column };
    this.selection.set({ active, anchor: active, mode: 'cells' });
  }

  /** A click on a cell or a row number: the grid takes it, as it holds the keyboard. */
  protected clicked(event: MouseEvent) {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!target) return;
    const mode = target.dataset['mode'] === 'rows' ? 'rows' : 'cells';
    this.select(Number(target.dataset['row']), Number(target.dataset['column'] ?? 0), event, mode);
  }
  protected contextMenu(event: MouseEvent) {
    if (!(event.target as HTMLElement).closest('[data-column]')) return;
    event.preventDefault();
    this.clicked(event);
    this.menu.set(true);
  }

  /** What the column menu does with the active cell's column. */
  protected menuChosen(choice: string, column: number) {
    this.closeMenu();
    const width = this.layout.widthOf(column);
    if (this.columnTools.run(choice, column, this.layout.order(), width)) return;
    if (choice === 'value') return this.panel.set('value');
    if (choice.startsWith('copy:')) return this.copy(undefined, choice.slice(5) as CopyFormat);
    const active = this.active();
    if (active)
      this.cellAction.emit({ action: choice, column: active.column, value: active.value });
  }
  protected closeMenu() {
    this.menu.set(false);
    this.viewport()?.nativeElement.focus({ preventScroll: true });
  }
}
