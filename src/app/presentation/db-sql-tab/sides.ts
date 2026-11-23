import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model } from '@angular/core';

/** The panel beside the script of a SQL tab, one at a time, or none. */
export type DbSqlSide = '' | 'history' | 'variables' | 'outline' | 'templates' | 'ai';

/**
 * The buttons of the SQL toolbar that open each panel beside the script, a second click
 * closing it. The AI assistant has its own button, beside the views.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-sides',
  template: `
    @for (each of sides; track each[0]) {
      <button
        type="button"
        class="button small subtle"
        [attr.aria-pressed]="side() === each[0]"
        (click)="side.set(side() === each[0] ? '' : each[0])"
      >
        {{ each[1] | transloco }}
      </button>
    }
  `,
  // The buttons are items of the toolbar, that wraps them with the others.
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class DbSqlSides {
  readonly side = model<DbSqlSide>('');
  protected readonly sides = [
    ['history', 'History'],
    ['variables', 'Variables'],
    ['outline', 'Outline'],
    ['templates', 'Templates'],
  ] as const;
}
