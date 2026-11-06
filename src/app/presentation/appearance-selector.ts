import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { visualTemplates } from '../domain/appearance';
import { AppearanceState } from './appearance-state';

@Component({
  selector: 'app-appearance-selector',
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="template-selector">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
      <span>{{ 'Template' | transloco }}</span>
      <select [formField]="fields.template" [attr.aria-label]="'Visual template' | transloco">
        @for (template of templates; track template.id) {
          <option [value]="template.id">{{ template.name }}</option>
        }
      </select>
    </label>
    <button
      type="button"
      class="reset-layout"
      [disabled]="!appearance.resized()"
      [attr.aria-label]="'Reset layout' | transloco"
      [title]="'Reset layout: panels back to the template size' | transloco"
      (click)="appearance.resetLayout()"
    >
      ↺
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .template-selector {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 11px;
    }
    select {
      padding: 7px 24px 7px 9px;
      background: var(--panel-2);
      border-radius: 8px;
      font-weight: 600;
      color: var(--text);
    }
    .reset-layout {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      font-size: 15px;
      line-height: 1;
    }
    .reset-layout:disabled {
      opacity: 0.35;
      cursor: default;
    }
    @media (max-width: 1100px) {
      .template-selector > span {
        display: none;
      }
    }
  `,
})
export class AppearanceSelector {
  protected readonly appearance = inject(AppearanceState);
  protected readonly fields = form(this.appearance.model);
  protected readonly templates = visualTemplates;
}
