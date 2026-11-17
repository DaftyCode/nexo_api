import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ScriptClient } from './db-panel/sql-client';

/**
 * The «Variables» panel of a SQL tab, as DBeaver's: the client variables of its scripts
 * (`@set name = value`, used as `${name}`), to see, change, add and remove.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-variables',
  template: `
    <aside class="db-variables" [attr.aria-label]="'Variables' | transloco">
      <header class="row db-variables-head">
        <h3>{{ 'Variables' | transloco }}</h3>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'Close' | transloco"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>
      <p class="muted">{{ 'db.variables.help' | transloco }}</p>
      <ul>
        @for (entry of entries(); track entry[0]) {
          <li class="row">
            <code>{{ '\${' + entry[0] + '}' }}</code>
            <input
              [value]="entry[1]"
              [attr.aria-label]="'db.variables.value' | transloco: { v0: entry[0] }"
              (change)="client().setVariable(entry[0], $any($event.target).value)"
            />
            <button
              type="button"
              class="icon-button"
              [attr.aria-label]="'db.variables.remove' | transloco: { v0: entry[0] }"
              (click)="client().unsetVariable(entry[0])"
            >
              ×
            </button>
          </li>
        }
      </ul>
      <form class="row" (submit)="$event.preventDefault(); add()">
        <input
          [value]="name()"
          [attr.aria-label]="'New variable' | transloco"
          [placeholder]="'Name' | transloco"
          (input)="name.set($any($event.target).value)"
        />
        <button type="submit" class="button small" [disabled]="!valid()">
          {{ 'Add' | transloco }}
        </button>
      </form>
    </aside>
  `,
  styles: `
    .db-variables {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-3);
      width: calc(var(--nexo-size-unit) * 130);
      padding: var(--nexo-space-5);
      border-left: var(--nexo-border-width) solid var(--nexo-color-border);
      overflow: auto;
    }
    .db-variables-head {
      justify-content: space-between;
    }
    .db-variables h3 {
      margin: 0;
      font-size: var(--nexo-font-size-lg);
    }
    ul {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li,
    form {
      gap: var(--nexo-space-3);
      align-items: center;
    }
    input {
      flex: 1;
      min-width: 0;
    }
  `,
})
export class DbSqlVariables {
  readonly client = input.required<ScriptClient>();
  readonly closed = output<void>();
  protected readonly entries = computed(() => [...this.client().variables()]);
  protected readonly name = signal('');
  protected readonly valid = computed(() => /^[A-Za-z_][\w.]*$/.test(this.name()));

  protected add() {
    if (!this.valid()) return;
    this.client().setVariable(this.name(), '');
    this.name.set('');
  }
}
