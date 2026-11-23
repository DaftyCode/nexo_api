import { TranslocoPipe } from '@jsverse/transloco';
import { booleanAttribute, ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { StudioIcon } from './studio-icon';

/**
 * The button that opens the AI assistant (IA-01) beside a SQL script, a MongoDB collection or
 * a request: drawn in the accent, with its own icon, so it is seen at a glance, and filled
 * while the chat is open.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-toggle',
  template: `
    <button
      type="button"
      class="button ai-toggle"
      [class.small]="small()"
      [attr.aria-pressed]="open()"
      [attr.title]="'AI assistant' | transloco"
      (click)="open.set(!open())"
    >
      <app-studio-icon name="sparkles" /><span class="ai-toggle-label">{{
        'AI assistant' | transloco
      }}</span>
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    .ai-toggle {
      gap: var(--nexo-space-2);
      border-color: var(--nexo-color-accent-border);
      background: var(--nexo-color-accent-soft);
      color: var(--nexo-color-accent-strong);
      font-weight: var(--nexo-font-weight-semibold);
    }
    .ai-toggle:hover {
      border-color: var(--nexo-color-accent);
      background: var(--nexo-color-accent-soft);
    }
    .ai-toggle[aria-pressed='true'] {
      border-color: var(--nexo-color-accent);
      background: var(--nexo-color-accent);
      color: var(--nexo-color-on-accent);
    }
    .ai-toggle[aria-pressed='true']:hover {
      background: var(--nexo-color-accent-hover);
    }
    /* In a narrow toolbar (the SQL one is a container), its icon alone, named by its title,
       keeps the other buttons on fewer lines. */
    @container (max-width: 1100px) {
      .ai-toggle.small .ai-toggle-label {
        display: none;
      }
    }
  `,
})
export class AiToggle {
  /** Whether the chat is open. */
  readonly open = model(false);
  /** The size of the buttons of a dense toolbar. */
  readonly small = input(false, { transform: booleanAttribute });
}
