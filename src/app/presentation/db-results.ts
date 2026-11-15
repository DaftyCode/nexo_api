import { DatePipe } from '@angular/common';
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
import { WorkspaceState } from './workspace-state';
import type { SqlRunner } from './db-panel/sql-runner';

type Part = 'rows' | 'meta' | 'info' | 'summary';
/** The tab of the messages, beside the results. */
const MESSAGES = 'messages';

/**
 * The results under a SQL editor, as SQuirreL shows them: a tab per query with its rows,
 * metadata, information and summary; run again, pinned, closed, detached to a floating
 * window, read further or repeated; and the messages of what ran without rows.
 */
@Component({
  imports: [TranslocoPipe, FormField, DataGrid, DatePipe],
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
  protected readonly parts: readonly Part[] = ['rows', 'meta', 'info', 'summary'];
  protected readonly settings = signal({ seconds: 10, max: 15 });
  protected readonly settingsFields = form(this.settings, (path) => {
    min(path.seconds, 1);
    max(path.seconds, 3600);
    min(path.max, 1);
    max(path.max, 100);
  });
  protected readonly title = resultTitle;
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
      .find((tab) => tab.id === this.shown()),
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
}
