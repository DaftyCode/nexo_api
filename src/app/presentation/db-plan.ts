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
import { CodeLanguage } from './code-language';
import { CodeEditor } from './code-editor';
import { PlanMode, planRows, planWarnings } from '../domain/db/plan';
import { ResultTab } from '../domain/db/results';
import { DbSection } from './db-panel/section';
import { SqlPlans } from './db-panel/sql-plans';
import type { SqlRunner } from './db-panel/sql-runner';
import { success } from './workspace-state';

/**
 * The plan of a statement in its result tab, as DBeaver shows it: what to look at first, the
 * tree of its nodes with their rows and their cost (or time, once measured) with a bar of
 * each one's share, a node's details, and the plan as the engine wrote it.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-plan',
  templateUrl: './db-plan.html',
  styleUrl: './db-plan.scss',
})
export class DbPlan {
  readonly tab = input.required<ResultTab>();
  readonly runner = input.required<SqlRunner>();
  private readonly section = inject(DbSection);
  protected readonly plan = computed(() => this.tab().plan!);
  protected readonly view = signal<'tree' | 'original'>('tree');
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly selected = signal('');
  protected readonly rows = computed(() => planRows(this.plan(), this.collapsed()));
  protected readonly warnings = computed(() => planWarnings(this.plan()));
  /** The bars measure time once the plan was run, its cost before. */
  protected readonly timed = computed(() => this.plan().mode === 'actual');
  protected readonly chosen = computed(
    () => planRows(this.plan()).find((row) => row.id === this.selected())?.node,
  );
  protected readonly language = computed((): CodeLanguage => {
    const format = this.plan().format;
    return format === 'json' || format === 'xml' ? format : 'text';
  });
  /** The driver measures plans too (SQLite only estimates). */
  protected readonly measures = computed(() =>
    (this.section.drivers.capabilities(this.connection())?.explain ?? []).includes('actual'),
  );
  private readonly plans = computed(() => new SqlPlans(this.runner()));

  constructor() {
    // Another plan starts on its tree, with every node open; the same one, measured again,
    // keeps how it was shown.
    let shown = '';
    effect(() => {
      const id = this.tab().id;
      if (id === shown) return;
      shown = id;
      untracked(() => {
        this.view.set('tree');
        this.collapsed.set(new Set());
        this.selected.set('');
      });
    });
  }

  private connection() {
    return this.runner().connection()?.id ?? '';
  }

  protected toggle(id: string) {
    this.collapsed.update((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  /** Shows a node a warning is about: its branch opened and the node chosen. */
  protected show(id: string) {
    this.view.set('tree');
    this.collapsed.update((all) => new Set([...all].filter((open) => !id.startsWith(`${open}.`))));
    this.selected.set(id);
  }
  protected again(mode: PlanMode) {
    void this.plans().again(this.tab(), mode);
  }
  protected async copy() {
    await globalThis.navigator?.clipboard?.writeText(this.plan().original);
    this.section.state.tell(success('Copied to the clipboard'));
  }
  protected close() {
    const id = this.tab().id;
    this.runner().results.close((tab) => tab.id === id);
  }
  protected number(value: number | undefined) {
    return value === undefined ? '' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  protected details(row: { details?: Record<string, string> }) {
    return Object.entries(row.details ?? {});
  }
}
