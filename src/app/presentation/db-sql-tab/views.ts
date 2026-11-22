import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { StudioIcon } from '../studio-icon';

/**
 * «Text» or «Visual»: how a SQL tab shows its script (DB-26), as a switch of two segments
 * whose chosen one is filled, so the visual builder is seen at a glance.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-views',
  template: `
    <span class="db-sql-views" role="group" [attr.aria-label]="'View' | transloco">
      <button
        type="button"
        [attr.aria-pressed]="view() === 'text'"
        [attr.title]="'Write the script as text' | transloco"
        (click)="view.set('text')"
      >
        <app-studio-icon name="code" />{{ 'Text' | transloco }}
      </button>
      <button
        type="button"
        [attr.aria-pressed]="view() === 'visual'"
        [attr.title]="'Build the SELECT at the cursor on a canvas' | transloco"
        (click)="view.set('visual')"
      >
        <app-studio-icon name="schema" />{{ 'Visual' | transloco }}
      </button>
    </span>
  `,
  styles: `
    .db-sql-views {
      display: inline-flex;
      border: var(--nexo-border-width) solid var(--nexo-color-accent-border);
      border-radius: var(--nexo-radius-sm);
      overflow: hidden;
    }
    button {
      display: inline-flex;
      align-items: center;
      gap: var(--nexo-space-2);
      padding: var(--nexo-space-1) var(--nexo-space-4);
      border: 0;
      background: var(--nexo-color-surface);
      color: var(--nexo-color-text);
      font: inherit;
      font-size: var(--nexo-font-size-sm);
      font-weight: var(--nexo-font-weight-semibold);
      cursor: pointer;
    }
    button + button {
      border-inline-start: var(--nexo-border-width) solid var(--nexo-color-accent-border);
    }
    button:hover {
      background: var(--nexo-color-accent-soft);
    }
    button:focus-visible {
      outline: var(--nexo-focus-ring-width) solid var(--nexo-color-focus-ring);
      outline-offset: calc(-1 * var(--nexo-focus-ring-width));
    }
    button[aria-pressed='true'] {
      background: var(--nexo-color-accent);
      color: var(--nexo-color-on-accent);
    }
  `,
})
export class DbSqlViews {
  readonly view = model<'text' | 'visual'>('text');
}
