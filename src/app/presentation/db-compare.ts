import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  inject,
  input,
  runInInjectionContext,
  untracked,
} from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { COMPARE_STATUSES, ComparedObject, RowDifference, shownValue } from '../domain/db/compare';
import { isDbConnection } from '../domain/db/connection';
import { CompareDraft } from './db-panel/compare-draft';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';

/**
 * «Compare» of a schema, database or table (DB-24): with another one of the same connection
 * or of another (also of another engine), its structure part by part with both DDLs side by
 * side, or its rows by key; the script that makes the target like the source, opened in a
 * SQL tab, and the rows synchronized after the target table's name is typed.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-compare',
  templateUrl: './db-compare.html',
  styleUrl: './db-compare.scss',
})
export class DbCompare {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly statuses = COMPARE_STATUSES;
  protected readonly shown = shownValue;
  private readonly injector = inject(Injector);
  private draftOf?: CompareDraft;

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.draftOf?.close());
  }

  /** The draft of the tab, made once (its form needs the injector, outside any template read). */
  protected draft(): CompareDraft {
    this.draftOf ??= untracked(() =>
      runInInjectionContext(this.injector, () => new CompareDraft(this.section, this.tab())),
    );
    return this.draftOf;
  }

  protected readonly source = computed(() => {
    const tab = this.tab();
    const name = this.section.connection(tab.connection)?.name ?? '';
    return [
      name,
      ...(tab.path ?? []).filter((part) => !['schemas', 'databases', 'tables'].includes(part)),
    ].join(' / ');
  });
  /** Connections that can be the target: every SQL connection. */
  protected readonly targets = computed(() =>
    this.section.state.documents().filter(isDbConnection),
  );
  /** The objects that differ first, then the rest. */
  protected readonly objects = computed(() => {
    const objects = this.draft().structure()?.objects ?? [];
    return [...objects].sort(
      (a, b) => this.statuses.indexOf(a.status) - this.statuses.indexOf(b.status),
    );
  });

  protected chooseTarget(event: Event) {
    const target = (event.target as HTMLSelectElement).value;
    this.draft().model.update((m) => ({ ...m, target, targetPath: '' }));
    void this.task.run(() => this.draft().loadCandidates());
  }

  protected compare() {
    void this.task.run(() => this.draft().compare());
  }
  protected show(object: ComparedObject) {
    void this.task.run(() => this.draft().show(object));
  }
  protected makeScript() {
    void this.task.run(() => this.draft().makeScript());
  }
  protected sync() {
    void this.section.state.announce('The rows could not be synchronized', () =>
      this.draft().sync(),
    );
  }
  protected cancel() {
    void this.task.run(() => this.draft().cancel());
  }

  protected statusLabel(status: string) {
    return `db.compare.status.${status}`;
  }
  protected partLabel(part: string) {
    return `db.compare.part.${part}`;
  }
  protected fieldLabel(field: string) {
    return `db.compare.field.${field}`;
  }
  /** The values of a row of one side, by column, key first. */
  protected values(difference: RowDifference, side: 'source' | 'target'): string {
    const row = difference[side];
    return row ? row.map((value) => this.shown(value)).join(' · ') : '';
  }
  protected candidateKey(path: readonly string[]) {
    return JSON.stringify(path);
  }
}
