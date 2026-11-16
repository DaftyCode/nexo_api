import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
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
import { GridFormats, formatCell } from '../../domain/db/grid/cells';
import { SqlStyle } from '../../domain/db/grid/copy';
import {
  GridSelection,
  clickSelection,
  isSelected,
  selectedRange,
  startSelection,
} from '../../domain/db/grid/selection';
import { plainText } from '../../domain/db/grid/text';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { columnBadge } from '../../domain/db/look';
import { ResultColumn } from '../../domain/db/results';
import { StudioIcon } from '../studio-icon';
import { WorkspaceState } from '../workspace-state';
import { GridColumns } from './columns';
import { GridFind } from './find';
import { GridBar } from './grid-bar';
import { GridMenu } from './grid-menu';
import { GridPanels, PanelKind } from './grid-panels';
import { GridLayout } from './layout';
import { GridRecord } from './grid-record';
import { GridFormatsState } from './formats';
import { gridKey } from './keys';
import { GridMenus } from './menu-actions';
import { GridOutput } from './output';
import { GridPointer } from './pointer';
import { CellAction, GroupingSource } from './types';

export type { CellAction, GroupingSource } from './types';

let grids = 0;

/**
 * The data grid of the database section, as DBeaver's: virtualized in rows and columns (only
 * what is in sight is drawn, and the next page is read on reaching the end), a WAI-ARIA grid
 * for the keyboard, cells formatted by class, columns resized, fitted, moved, hidden and
 * pinned, order and filter over what was loaded, find, record view, copy and download in
 * several formats, a plain text view, full screen, and side panels.
 */
@Component({
  imports: [TranslocoPipe, NgTemplateOutlet, GridBar, GridPanels, GridMenu, GridRecord, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-data-grid',
  templateUrl: './data-grid.html',
  styleUrls: ['./data-grid.scss', './data-grid/chrome.scss'],
  host: {
    '[class.grid-maximized]': 'maximized()',
    '(document:click)': 'menus.open.set(undefined)',
    '(keydown.escape)': 'maximized.set(false)',
  },
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
  private readonly state = inject(WorkspaceState);
  private readonly i18n = inject(TranslocoService);
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
  protected readonly maximized = signal(false);
  protected readonly filterText = signal('');
  protected readonly findText = signal('');
  protected readonly layout = new GridLayout({
    columns: () => this.columns(),
    rows: () => this.rows(),
    view: () => this.view(),
    filter: () => this.filterText(),
  });
  protected readonly find = new GridFind(
    () => this.findText(),
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
  protected readonly names = computed(() => this.columns().map((column) => column.name));
  /** How many rows the selection spans. */
  protected readonly chosenRows = computed(() => {
    const rows = this.layout.shown().length;
    if (!rows) return 0;
    const range = selectedRange(this.selection(), rows, this.layout.order().length);
    return range.bottom - range.top + 1;
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
  protected readonly output = new GridOutput({
    layout: this.layout,
    selection: () => this.selection(),
    columns: () => this.columns(),
    rows: () => this.rows(),
    sql: () => this.sql(),
    label: () => this.label(),
    save: (name, text, type) => void this.state.download(name, text, type),
  });
  protected readonly menus = new GridMenus({
    columns: this.columnTools,
    layout: this.layout,
    selection: this.selection,
    active: () => this.active(),
    hidden: () => this.view().hidden,
    panel: this.panel,
    recordView: this.recordView,
    textView: this.textView,
    find: this.find,
    copy: (format) => this.output.copy(undefined, format),
    download: (format) => this.output.download(format),
    cellAction: (action, column, value) => this.cellAction.emit({ action, column, value }),
    focus: () => this.viewport()?.nativeElement.focus({ preventScroll: true }),
  });
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
  protected badgeOf(column: number) {
    return columnBadge(this.columns()[column]);
  }
  protected number(value: number) {
    return new Intl.NumberFormat(this.i18n.getActiveLang()).format(value);
  }
  protected cellId(position: number, column: number) {
    return `${this.id}-${position}-${column}`;
  }
  /** The active cell's id while it is drawn: the grid names no cell that is not there. */
  protected activeId() {
    const { row, column } = this.selection().active;
    const drawn =
      this.layout.drawnRows().some((drawn) => drawn.position === row) &&
      (column < this.layout.pinned().length ||
        this.layout.drawnColumns().some((drawn) => drawn.position === column));
    return drawn ? this.cellId(row, column) : null;
  }
  protected selected(position: number, column: number) {
    const rows = this.layout.shown().length;
    return isSelected(this.selection(), rows, this.layout.order().length, position, column);
  }
  /** A row chosen whole, by its number or its `⋯`. */
  protected rowChosen(position: number) {
    return this.selection().mode === 'rows' && this.selected(position, 0);
  }
  protected sortOf(column: number) {
    const sort = this.view().sort;
    return sort?.column !== column ? 'none' : sort.descending ? 'descending' : 'ascending';
  }
  protected arrow(column: number) {
    return { none: '', ascending: '▲', descending: '▼' }[this.sortOf(column)];
  }

  protected scrolled() {
    const element = this.viewport()?.nativeElement;
    if (element) this.layout.read(element);
  }
  private reveal() {
    const element = this.viewport()?.nativeElement;
    if (element) this.layout.reveal(element, this.selection().active);
  }

  protected key(event: KeyboardEvent) {
    gridKey(event, {
      layout: this.layout,
      selection: this.selection,
      panel: this.panel,
      findOpen: this.find.open,
      copy: (keys) => this.output.copy(keys, 'text'),
      menu: () => {
        const cell = this.viewport()?.nativeElement.querySelector('.grid-active');
        this.menus.under(cell ?? this.viewport()?.nativeElement);
      },
      reveal: () => this.reveal(),
    });
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
    const at = {
      row: Number(target.dataset['row']),
      column: Number(target.dataset['column'] ?? 0),
    };
    this.selection.set(clickSelection(this.selection(), at, mode, event.shiftKey));
    this.viewport()?.nativeElement.focus({ preventScroll: true });
  }
  protected contextMenu(event: MouseEvent) {
    if (!(event.target as HTMLElement).closest('[data-column]')) return;
    event.preventDefault();
    this.clicked(event);
    this.menus.at(event.clientX, event.clientY);
  }
}
