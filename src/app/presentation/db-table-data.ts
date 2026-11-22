import { ResultChartConfig, autoChart } from '../domain/db/result-chart';
import { ResultChart } from './charts/result-chart';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import { GridView } from '../domain/db/grid/view';
import { cellText } from '../domain/db/results';
import {
  ForeignKey,
  QuickOperator,
  TableQuery,
  emptyTableQuery,
  orderBy,
} from '../domain/db/table-query';
import { CodeEditor } from './code-editor';
import { DbRowEdits, EDIT_ACTIONS, editAction } from './db-row-edits';
import { CellAction, DataGrid } from './data-grid/data-grid';
import { DbSection } from './db-panel/section';
import { PAGES } from './db-panel/table-data';
import type { DbTab } from './db-panel/tabs-store';
import { PopupPlace, placeBy } from './popup-place';
import { StudioIcon } from './studio-icon';

/** The quick filters a cell offers, and the orders, as DBeaver's. */
const ACTIONS: readonly CellAction[] = [
  { id: 'eq', label: 'Filter: equal to this value' },
  { id: 'ne', label: 'Filter: different from this value' },
  { id: 'contains', label: 'Filter: contains this value' },
  { id: 'null', label: 'Filter: is NULL' },
  { id: 'notnull', label: 'Filter: is not NULL' },
  { id: 'order-add', label: 'Add the column to the order' },
];

/**
 * The «Data» tab of a table or view: its rows from the server, filtered by a condition and
 * by quick filters from cells (their values as parameters), ordered by one or more columns
 * on the server; the statement it runs, the count of the rows, refreshing, and the rows
 * related by its foreign keys.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, DataGrid, DbRowEdits, StudioIcon, ResultChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-table-data',
  templateUrl: './db-table-data.html',
  styleUrl: './db-table-data.scss',
  host: { '(keydown)': 'shortcut($event)', '(document:click)': 'refreshMenu.set(undefined)' },
})
export class DbTableData {
  readonly tab = input.required<DbTab>();
  /** The keys of the table, from its description: those it has and those pointing to it. */
  readonly parents = input<readonly ForeignKey[]>([]);
  readonly children = input<readonly ForeignKey[]>([]);
  /** The rows the server estimates the table has, from its description. */
  readonly estimated = input<number | undefined>(undefined);
  protected readonly section = inject(DbSection);
  private readonly i18n = inject(TranslocoService);
  protected readonly data = computed(() => this.section.editors.table(this.tab().id));
  protected readonly query = computed(() => this.tab().query ?? emptyTableQuery());
  /** The quick filters, and the edits while the rows can be edited. */
  protected readonly cellActions = computed(() =>
    this.data().editor.reason() ? ACTIONS : [...ACTIONS, ...EDIT_ACTIONS],
  );
  protected readonly model = signal({ where: '', every: 10, page: '200' });
  protected readonly pages = PAGES;
  protected readonly refreshMenu = signal<PopupPlace | undefined>(undefined);
  protected readonly fields = form(this.model, (path) => {
    min(path.every, 1);
    max(path.every, 3600);
  });
  protected readonly showStatement = signal(false);
  /** The chart of the rows loaded, while it is shown (DB-28). */
  protected readonly chart = signal<ResultChartConfig | undefined>(undefined);
  protected readonly chartOf = () => autoChart(this.data().editor.grid().columns);
  protected readonly showRelated = signal(false);
  protected readonly words = computed(() =>
    this.data()
      .columns()
      .map((column) => column.name),
  );
  protected readonly text = cellText;
  /** The rows of the whole table: counted, else as the server estimates them. */
  protected readonly total = computed(() => this.data().count() ?? this.estimated());
  protected readonly estimate = computed(() => {
    const estimated = this.estimated();
    return estimated === undefined ? undefined : this.number(estimated);
  });
  protected readonly loaded = computed(() => {
    const loaded = this.number(this.data().rows().length);
    const total = this.total();
    return total === undefined
      ? this.i18n.translate('db.data.rows', { v0: loaded })
      : this.i18n.translate('db.data.rowsOf', {
          v0: loaded,
          v1: `${this.data().count() === undefined ? '~' : ''}${this.number(total)}`,
        });
  });
  protected readonly state = computed(() => {
    const data = this.data();
    return data.loading() ? 'Reading the rows' : data.error() ? 'The query failed' : 'Query ready';
  });
  private activeRow = -1;
  private relating?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const tab = this.tab();
      untracked(() => {
        const data = this.section.editors.table(tab.id);
        this.model.update((model) => ({
          ...model,
          where: tab.query?.where ?? '',
          page: String(data.page()),
        }));
        if (!data.columns().length) void data.load();
      });
    });
    // Another page size reads the first page again with it.
    effect(() => {
      const page = Number(this.model().page);
      untracked(() => {
        const data = this.data();
        if (!PAGES.includes(page) || page === data.page()) return;
        data.page.set(page);
        void data.load();
      });
    });
  }

  private number(value: number) {
    return new Intl.NumberFormat(this.i18n.getActiveLang()).format(value);
  }

  /** F5 runs the condition, as in DBeaver, instead of reloading the page. */
  protected shortcut(event: KeyboardEvent) {
    if (event.key !== 'F5' || event.defaultPrevented) return;
    event.preventDefault();
    this.apply();
  }

  protected toggleRefresh(event: MouseEvent) {
    if (this.refreshMenu()) return this.refreshMenu.set(undefined);
    this.refreshMenu.set(placeBy(event.currentTarget as HTMLElement));
  }

  /** Keeps the query in the tab (and so in the session) and reads the rows again. */
  private change(query: TableQuery) {
    this.section.tabs.update(this.tab().id, { query });
    void this.data().load();
  }

  protected apply() {
    this.change({ ...this.query(), where: this.model().where });
  }
  protected removeQuick(index: number) {
    this.change({ ...this.query(), quick: this.query().quick.filter((_, at) => at !== index) });
  }
  /** Adds `ALLOW FILTERING` to the filter of a Cassandra table, once the person confirms. */
  protected allowFiltering(allow = true) {
    if (allow && !this.section.state.confirm('db.confirm.allowFiltering')) return;
    this.change({ ...this.query(), allowFiltering: allow });
  }
  protected removeOrder(index: number) {
    this.change({ ...this.query(), order: this.query().order.filter((_, at) => at !== index) });
  }
  protected clear() {
    this.model.update((model) => ({ ...model, where: '' }));
    this.change(emptyTableQuery());
  }

  /** A header clicked orders on the server, not over the rows read. */
  protected viewChanged(view: GridView) {
    const sort = view.sort;
    if (!sort) return this.data().view.set(view);
    this.data().view.set({ ...view, sort: undefined });
    const column = this.data().columns()[sort.column]?.name;
    if (column) this.change(orderBy(this.query(), column, false));
  }

  protected cellAction(event: { action: string; column: number; value: unknown; rows: number[] }) {
    if (event.action.startsWith('edit.')) return editAction(this.data().editor, event);
    const column = this.data().columns()[event.column]?.name;
    if (!column) return;
    if (event.action === 'order-add') return this.change(orderBy(this.query(), column, true));
    const operator = event.action as QuickOperator;
    const needsValue = operator === 'eq' || operator === 'ne' || operator === 'contains';
    const filter = { column, operator, ...(needsValue ? { value: event.value } : {}) };
    this.change({ ...this.query(), quick: [...this.query().quick, filter] });
  }

  protected quickLabel(operator: QuickOperator) {
    return `db.quick.${operator}`;
  }

  protected toggleEvery() {
    const data = this.data();
    data.refreshEvery(data.every() ? 0 : this.model().every);
  }

  protected openInScript() {
    this.section.newScript(this.tab().connection, { text: this.data().statement() });
  }

  /** The rows related to the active row, read a moment after it stops changing. */
  protected rowChanged(row: number) {
    this.activeRow = row;
    if (this.showRelated()) this.relate();
  }
  protected toggleRelated() {
    this.showRelated.update((shown) => !shown);
    if (this.showRelated()) this.relate();
  }
  private relate() {
    clearTimeout(this.relating);
    this.relating = setTimeout(
      () => void this.data().relate(this.activeRow, this.parents(), this.children()),
      250,
    );
  }

  /** Opens the table of a related key in its own tab. */
  protected openRelated(key: ForeignKey) {
    const tab = this.tab();
    const path = tab.path ?? [];
    if (path.length < 3) return;
    const target = [...path.slice(0, -3), key.schema || path.at(-3)!, path.at(-2)!, key.table];
    this.section.tabs.open({
      kind: 'object',
      connection: tab.connection,
      title: key.table,
      path: target,
    });
  }
}
