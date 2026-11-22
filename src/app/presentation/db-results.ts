import { DatePipe } from '@angular/common';
import { SqlPlans } from './db-panel/sql-plans';
import { DbPlan } from './db-plan';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import { ResultTab, resultTitle, summarize } from '../domain/db/results';
import { sourceTable } from '../domain/db/grid/copy';
import { DataGrid } from './data-grid/data-grid';
import { DbResultMeta } from './db-results/meta';
import { ResultChart } from './charts/result-chart';
import { ResultChartConfig, chartKey } from '../domain/db/result-chart';
import { geometryOf } from '../domain/db/geometry';
import { DbSpatial } from './db-spatial';
import { DbRowEdits, EDIT_ACTIONS, editAction } from './db-row-edits';
import type { RowEditor } from './db-panel/row-editor';
import { WorkspaceState } from './workspace-state';
import type { SqlRunner } from './db-panel/sql-runner';

type Part = 'rows' | 'meta' | 'info' | 'summary' | 'chart' | 'spatial';
/** The tab of the messages, beside the results. */
const MESSAGES = 'messages';

/**
 * The results under a SQL editor, as SQuirreL shows them: a tab per query with its rows,
 * metadata, information and summary; run again, pinned, closed, detached to a floating
 * window, read further or repeated; and the messages of what ran without rows.
 */
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    DataGrid,
    DbRowEdits,
    DatePipe,
    DbPlan,
    DbResultMeta,
    ResultChart,
    DbSpatial,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-results',
  templateUrl: './db-results.html',
  styleUrl: './db-results.scss',
})
export class DbResults {
  readonly runner = input.required<SqlRunner>();
  /** Where the editor goes from an error: an offset of its text. */
  readonly goTo = output<number>();
  protected readonly part = signal<Part>('rows');
  protected readonly parts: readonly Part[] = [
    'rows',
    'meta',
    'info',
    'summary',
    'chart',
    'spatial',
  ];
  /** Whether a result holds geometries, for its «Spatial» view (DB-29). */
  protected readonly spatial = (tab: ResultTab) =>
    tab.columns.some((column) => column.kind === 'spatial') ||
    tab.rows.slice(0, 20).some((row) => row.some((cell) => !!geometryOf(cell)));
  /** The charts of the script, by statement (DB-28). */
  readonly charts = input<Readonly<Record<string, ResultChartConfig>>>({});
  readonly chartChange = output<{ key: string; config: ResultChartConfig }>();
  protected readonly chartKey = chartKey;
  protected readonly settings = signal({ seconds: 10, max: 15 });
  protected readonly settingsFields = form(this.settings, (path) => {
    min(path.seconds, 1);
    max(path.seconds, 3600);
    min(path.max, 1);
    max(path.max, 100);
  });
  protected readonly title = resultTitle;
  /** Result tabs whose rows are being edited in the grid. */
  protected readonly editingOn = signal<ReadonlySet<string>>(new Set());
  protected readonly editActions = EDIT_ACTIONS;
  protected readonly messagesId = MESSAGES;
  protected readonly results = computed(() => this.runner().results);
  /** The tab shown: a result, or the messages when there is none. */
  protected readonly shown = computed(() => {
    const results = this.results();
    const active = results.active();
    return results.tabs().find((tab) => tab.id === active)?.id ?? MESSAGES;
  });
  protected readonly current = computed(() =>
    this.results()
      .tabs()
      .find((tab) => tab.id === this.shown() && !tab.plan),
  );
  /** The tab shown when it holds a plan (DB-16). */
  protected readonly planTab = computed(() =>
    this.results()
      .tabs()
      .find((tab) => tab.id === this.shown() && !!tab.plan),
  );
  protected readonly detached = computed(() =>
    this.results()
      .tabs()
      .find((tab) => tab.id === this.results().detached()),
  );
  private readonly state = inject(WorkspaceState);
  /** How the connection writes SQL, to copy as `IN` or `INSERT`. */
  protected readonly sqlStyle = computed(() => this.runner().sqlStyle());
  /** Grouping on the server, when the result shown comes from one table. */
  protected readonly grouping = computed(() => {
    const tab = this.current();
    const table = tab && sourceTable(tab.columns, this.sqlStyle());
    const runner = this.runner();
    return table ? (columns: readonly string[]) => runner.group(table, columns) : undefined;
  });
  protected readonly summary = computed(() => {
    const tab = this.current();
    return tab ? summarize(tab.columns, tab.rows) : [];
  });

  constructor() {
    queueMicrotask(() =>
      this.settings.update((value) => ({ ...value, max: this.runner().maxResults })),
    );
  }

  /** Where the floating window of a detached result is, moved by its title. */
  protected readonly floating = signal({ x: 96, y: 96 });
  private drag?: { x: number; y: number; left: number; top: number };

  protected isTab(id: string) {
    return (tab: ResultTab) => tab.id === id;
  }
  protected dragStart(event: PointerEvent) {
    if ((event.target as HTMLElement).closest('button')) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    const { x, y } = this.floating();
    this.drag = { x: event.clientX, y: event.clientY, left: x, top: y };
  }
  protected dragMove(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.floating.set({
      x: Math.max(0, drag.left + event.clientX - drag.x),
      y: Math.max(0, drag.top + event.clientY - drag.y),
    });
  }
  protected dragEnd() {
    this.drag = undefined;
  }

  /** Reads every row left, after saying it may be many. */
  protected readAll(tab: ResultTab) {
    if (this.state.confirm('db.readAll.confirm')) void this.results().readAll(tab.id);
  }

  protected show(id: string) {
    this.results().active.set(id);
  }
  protected partLabel(part: Part) {
    return `db.result.${part}`;
  }
  protected repeating(tab: ResultTab) {
    return this.results().repeating()[tab.id] ?? 0;
  }
  protected toggleRepeat(tab: ResultTab) {
    const seconds = this.repeating(tab) ? 0 : this.settings().seconds;
    this.results().repeat(tab.id, seconds);
  }
  /** Exports what a result's query reads, all its rows, with the transfer wizard. */
  protected exportTab(tab: ResultTab) {
    const runner = this.runner();
    const connection = runner.connection()?.id;
    if (connection)
      runner.section.transferRequest.set({
        kind: 'export',
        connection,
        sql: tab.sql,
        name: 'result',
      });
  }
  /** The plan of the statement that gave a result, in a tab of its own. */
  protected explain(tab: ResultTab) {
    void new SqlPlans(this.runner()).again(tab);
  }
  /** The code of a result's statement (DB-33), with the values last typed. */
  protected async showCode(tab: ResultTab) {
    const runner = this.runner();
    const values = (await runner.section.cases()).assist.parameters();
    runner.code.set({ query: { engine: runner.driver(), sql: tab.sql, values } });
  }
  protected closeOthers(tab: ResultTab) {
    this.results().close((other) => other.id !== tab.id && !other.pinned);
  }
  protected closeUnpinned() {
    this.results().close((other) => !other.pinned);
  }
  /** Keeps the most result tabs, for this editor and the next ones. */
  protected setMax() {
    void this.runner().setMaxResults(this.settings().max);
  }

  /** Arrows move between the result tabs. */
  protected tabKey(event: KeyboardEvent, id: string) {
    const ids = [
      ...this.results()
        .tabs()
        .map((tab) => tab.id),
      MESSAGES,
    ];
    const index = ids.indexOf(id);
    const next =
      event.key === 'ArrowRight'
        ? ids[(index + 1) % ids.length]
        : event.key === 'ArrowLeft'
          ? ids[(index - 1 + ids.length) % ids.length]
          : undefined;
    if (!next) return;
    event.preventDefault();
    this.show(next);
    const list = (event.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-result="${next}"]`)?.focus());
  }

  protected toggleEditing(tab: string) {
    this.editingOn.update((on) => {
      const next = new Set(on);
      if (!next.delete(tab)) next.add(tab);
      return next;
    });
  }
  protected edited(
    editor: RowEditor,
    event: { action: string; column: number; value: unknown; rows: number[] },
  ) {
    if (event.action.startsWith('edit.')) editAction(editor, event);
  }
}
