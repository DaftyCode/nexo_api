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
import { FormField, form } from '@angular/forms/signals';
import { HistoryEntry } from '../domain/db/sql';
import { DbSection } from './db-panel/section';

/**
 * The statements that ran on a connection, newest first, as DBeaver's Query Manager: with
 * their time, duration, rows or error, and a text filter. Choosing one puts it in the editor.
 */
@Component({
  imports: [TranslocoPipe, FormField, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-history',
  template: `
    <aside class="db-history" [attr.aria-label]="'History' | transloco">
      <header class="db-history-head">
        <h3>{{ 'History' | transloco }}</h3>
        <button type="button" class="button small subtle" (click)="load()">
          {{ 'Refresh' | transloco }}
        </button>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'Close the history' | transloco"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>
      <label class="field"
        >{{ 'Filter the history' | transloco
        }}<input type="search" [formField]="filterFields.text" autocomplete="off"
      /></label>
      <ul class="db-history-list" tabindex="0" [attr.aria-label]="'History' | transloco">
        @for (entry of shown(); track entry.id) {
          <li>
            <button
              type="button"
              class="db-history-entry"
              [class.db-history-error]="!!entry.error"
              [attr.title]="entry.error ?? entry.sql"
              (click)="chosen.emit(entry.sql)"
            >
              <code>{{ entry.sql }}</code>
              <span class="muted">
                {{ entry.startedAt | date: 'short' }} · {{ entry.durationMs }} ms ·
                @if (entry.error) {
                  {{ 'Failed' | transloco }}
                } @else if (entry.affected !== undefined && entry.affected !== null) {
                  {{ 'db.history.affected' | transloco: { v0: entry.affected } }}
                } @else {
                  {{ 'db.history.rows' | transloco: { v0: entry.rows ?? 0 } }}
                }
              </span>
            </button>
          </li>
        } @empty {
          <li class="muted">{{ 'Nothing ran on this connection yet.' | transloco }}</li>
        }
      </ul>
    </aside>
  `,
  styles: `
    :host {
      display: flex;
      width: calc(var(--nexo-size-unit) * 90);
      min-height: 0;
      border-left: var(--nexo-border-width) solid var(--nexo-color-border-subtle);
    }
    .db-history {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      padding: var(--nexo-space-3);
    }
    .db-history-head {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-2);
    }
    .db-history-head h3 {
      flex: 1;
      margin: 0;
      font-size: var(--nexo-font-size-sm);
    }
    .db-history-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .db-history-entry {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-1);
      width: 100%;
      padding: var(--nexo-space-2);
      border-bottom: var(--nexo-border-width) solid var(--nexo-color-border-subtle);
      color: var(--nexo-color-text);
      text-align: left;
      font-size: var(--nexo-font-size-xs);
    }
    .db-history-entry:hover {
      background: var(--nexo-color-hover);
    }
    .db-history-entry code {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .db-history-error code {
      color: var(--nexo-color-danger-text);
    }
  `,
})
export class DbHistory {
  readonly connection = input.required<string>();
  readonly chosen = output<string>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  private readonly entries = signal<readonly HistoryEntry[]>([]);
  protected readonly filter = signal({ text: '' });
  protected readonly filterFields = form(this.filter);
  protected readonly shown = computed(() => {
    const wanted = this.filter().text.trim().toLowerCase();
    return this.entries().filter(
      (entry) =>
        entry.connectionId === this.connection() &&
        (!wanted || entry.sql.toLowerCase().includes(wanted)),
    );
  });

  constructor() {
    void this.load();
  }

  /** Reads the history again: new statements were recorded as they ran. */
  protected async load() {
    await this.section.state.refresh();
    const cases = await this.section.cases();
    this.entries.set(await cases.statements.entries(this.section.state.documents()));
  }
}
