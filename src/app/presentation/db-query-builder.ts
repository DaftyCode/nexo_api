import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { DiagramTable } from '../domain/db/erd-document';
import { QueryModel, emptyQuery } from '../domain/db/query-model';
import {
  BuilderTable,
  addTable,
  columnOf,
  joinColumns,
  nextJoinKind,
  removeTable,
  toggleColumn,
} from '../domain/db/query-model/edit';
import { builderLayout, knownTable } from '../domain/db/query-model/layout';
import { querySql } from '../domain/db/query-model/sql';
import { quoteName } from '../domain/db/tree';
import { DbQueryCanvas } from './db-query-builder/canvas';
import { DbQueryPanels } from './db-query-builder/panels';
import { connectionTables, readTables } from './db-panel/diagram-load';
import { TABLE_DRAG } from './db-panel/diagrams';
import { DbSection } from './db-panel/section';
import { PanelTask } from './panel-task';
import { Splitter } from './splitter';

/** The text of the statement the builder writes, in the script. */
export interface BuilderEdit {
  from: number;
  to: number;
  text: string;
}

/**
 * The «Visual» view of a SQL tab (DB-26): the `SELECT` at the cursor as tables on a canvas,
 * with panels for columns, conditions, grouping, order and joins. Every change writes the
 * statement again in the script; a statement the model cannot hold whole is only shown, with
 * the reason, and never rewritten.
 */
@Component({
  imports: [TranslocoPipe, DbQueryCanvas, DbQueryPanels, Splitter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-query-builder',
  templateUrl: './db-query-builder.html',
  styleUrl: './db-query-builder.scss',
})
export class DbQueryBuilder {
  readonly connection = input.required<string>();
  readonly script = input.required<string>();
  readonly cursor = input.required<number>();
  readonly edited = output<BuilderEdit>();
  readonly run = output<void>();
  protected readonly section = inject(DbSection);
  /** The width of the list of tables dragged by the person; 0 fits its text. */
  protected readonly listWidth = signal(0);
  /** The height of the canvas dragged by the person; 0 fits its tables. */
  protected readonly topHeight = signal(0);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly model = signal<QueryModel>(emptyQuery());
  /** Why the statement is only shown: what it has that the model cannot hold. */
  protected readonly reason = signal('');
  protected readonly ready = signal(false);
  /** The tables of the connection, to add, and those read with their columns and keys. */
  protected readonly available = signal<DiagramTable[]>([]);
  protected readonly known = signal<BuilderTable[]>([]);
  protected readonly filter = signal('');
  protected readonly style = computed(() => this.section.drivers.sqlStyle(this.connection()));
  protected readonly quote = (name: string) => quoteName(name, this.style());
  protected readonly sql = computed(() => querySql(this.model(), this.style()));
  protected readonly layout = computed(() =>
    builderLayout(this.model(), this.known(), (alias, column) =>
      columnOf(alias, column, this.quote),
    ),
  );
  protected readonly choices = computed(() => {
    const wanted = this.filter().trim().toLowerCase();
    return this.available()
      .filter((table) => !wanted || table.name.toLowerCase().includes(wanted))
      .slice(0, 200);
  });
  /** Where the statement is in the script: what the builder replaces. */
  private range = { from: 0, to: 0 };

  constructor() {
    // Read once, when the inputs are there: the builder is opened again to read anew.
    const once = effect(() => {
      this.connection();
      untracked(() => void this.load());
      once.destroy();
    });
  }

  private async load() {
    const [connection, script, cursor] = untracked(() => [
      this.connection(),
      this.script(),
      this.cursor(),
    ]);
    await this.task.run(async () => {
      await this.section.drivers.learn(connection);
      const cases = (await this.section.cases()).builder;
      const workspace = this.section.state.workspaceId();
      const dialect = this.style().name;
      const statement = await cases.statementAt(workspace, script, dialect, cursor);
      this.range = statement
        ? { from: statement.start, to: statement.end }
        : { from: cursor, to: cursor };
      if (statement?.text.trim()) {
        const parsed = await cases.parse(workspace, statement.text, dialect);
        if ('unsupported' in parsed) this.reason.set(parsed.unsupported);
        else this.model.set(parsed.model);
      }
      this.available.set(await connectionTables(this.section, connection));
      const named = this.available().filter((table) =>
        this.model().tables.some((each) => knownTable(each, [{ ...table, columns: [], keys: [] }])),
      );
      if (named.length) await this.read(named);
    });
    this.ready.set(true);
  }

  /** Reads the columns and keys of some tables, keeping them. */
  private async read(tables: DiagramTable[]): Promise<BuilderTable[]> {
    const read = await readTables(this.section, this.connection(), tables);
    const found = read.map(({ entity, keys }) => ({
      path: entity.path,
      ...(entity.schema ? { schema: entity.schema } : {}),
      name: entity.name,
      columns: entity.columns.map((column) => column.name),
      keys,
    }));
    this.known.update((known) => [
      ...known.filter((each) => !found.some((one) => one.path.join('/') === each.path.join('/'))),
      ...found,
    ]);
    return found;
  }

  /** A change of the model: the statement is written again where it is. */
  protected update(model: QueryModel) {
    if (this.reason()) return;
    this.model.set(model);
    const text = querySql(model, this.style());
    this.edited.emit({ ...this.range, text });
    this.range = { from: this.range.from, to: this.range.from + text.length };
  }

  protected add(table: DiagramTable) {
    if (this.reason()) return;
    void this.task.run(async () => {
      const [read] = await this.read([table]);
      if (read) this.update(addTable(this.model(), read, this.known(), this.quote));
    });
  }
  protected toggle(expression: string) {
    this.update(toggleColumn(this.model(), expression));
  }
  protected join(link: { from: { table: number; expression: string }; to: typeof link.from }) {
    this.update(joinColumns(this.model(), link.from, link.to));
  }
  protected nextKind(table: number) {
    this.update(nextJoinKind(this.model(), table));
  }
  protected remove(index: number) {
    this.update(removeTable(this.model(), index, this.quote));
  }

  /** A table dragged from the navigator, of this connection. */
  protected dropped(event: DragEvent) {
    const data = event.dataTransfer?.getData(TABLE_DRAG);
    if (!data) return;
    event.preventDefault();
    try {
      const { connection, path } = JSON.parse(data) as { connection: string; path: string[] };
      const table = this.available().find((each) => each.path.join('/') === path.join('/'));
      if (connection === this.connection() && table) this.add(table);
    } catch {
      // Not a table of the navigator.
    }
  }
  protected over(event: DragEvent) {
    if (event.dataTransfer?.types.includes(TABLE_DRAG)) event.preventDefault();
  }
}
