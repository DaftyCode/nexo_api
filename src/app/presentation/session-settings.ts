import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WorkspaceState } from './workspace-state';
import { AppearanceState } from './appearance-state';

/** How Nexo opens: with the tabs left open or not, and the order of the side menu. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-session-settings',
  template: `
    <h3>{{ 'When Nexo opens' | transloco }}</h3>
    <label class="check">
      <input
        type="checkbox"
        [checked]="state.restoresTabs()"
        (change)="state.setRestoresTabs($any($event.target).checked)"
      />{{ 'Reopen the tabs left open, with their unsaved changes' | transloco }}
    </label>
    <p class="muted">
      {{
        'Tabs, the order of collections and the side menu stay as you leave them. Responses are never kept.'
          | transloco
      }}
    </p>
    @if (appearance.sectionsMoved()) {
      <button class="button" (click)="appearance.resetSections()">
        {{ 'Reset the side menu order' | transloco }}
      </button>
    }
  `,
})
export class SessionSettings {
  readonly state = inject(WorkspaceState);
  readonly appearance = inject(AppearanceState);
}
