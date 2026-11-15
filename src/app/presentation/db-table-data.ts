import { TranslocoPipe } from '@jsverse/transloco';
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
import { CellAction, DataGrid } from './data-grid/data-grid';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';

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
  imports: [TranslocoPipe, FormField, CodeEditor, DataGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-table-data',
  templateUrl: './db-table-data.html',
  styleUrl: './db-table-data.scss',
})
export class DbTableData {
  readonly tab = input.required<DbTab>();
  /** The keys of the table, from its description: those it has and those pointing to it. */
  readonly parents = input<readonly ForeignKey[]>([]);
  readonly children = input<readonly ForeignKey[]>([]);
  protected readonly section = inject(DbSection);
  protected readonly data = computed(() => this.section.editors.table(this.tab().id));
  protected readonly query = computed(() => this.tab().query ?? emptyTableQuery());
  protected readonly actions = ACTIONS;
  protected readonly model = signal({ where: '', every: 10 });
  protected readonly fields = form(this.model, (path) => {
    min(path.every, 1);
    max(path.every, 3600);
  });
  protected readonly showStatement = signal(false);
  protected readonly showRelated = signal(false);
  protected readonly words = computed(() =>
    this.data()
      .columns()
      .map((column) => column.name),
  );
  protected readonly text = cellText;
  private activeRow = -1;
  private relating?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const tab = this.tab();
      untracked(() => {
        this.model.update((model) => ({ ...model, where: tab.query?.where ?? '' }));
        const data = this.section.editors.table(tab.id);
        if (!data.columns().length) void data.load();
      });
    });
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

  protected cellAction(event: { action: string; column: number; value: unknown }) {
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
