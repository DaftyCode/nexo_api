import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model } from '@angular/core';

/** «Text» or «Visual»: how a SQL tab shows its script (DB-26). */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-views',
  template: `
    <span class="db-sql-views" role="group" [attr.aria-label]="'View' | transloco">
      <button
        type="button"
        class="button small subtle"
        [attr.aria-pressed]="view() === 'text'"
        (click)="view.set('text')"
      >
        {{ 'Text' | transloco }}
      </button>
      <button
        type="button"
        class="button small subtle"
        [attr.aria-pressed]="view() === 'visual'"
        [attr.title]="'Build the SELECT at the cursor on a canvas' | transloco"
        (click)="view.set('visual')"
      >
        {{ 'Visual' | transloco }}
      </button>
    </span>
  `,
})
export class DbSqlViews {
  readonly view = model<'text' | 'visual'>('text');
}
