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
      gap: var(--nexo-space-3);
      flex-shrink: 0;
    }
    .template-selector {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-3);
      color: var(--nexo-color-text-muted);
      font-size: var(--nexo-font-size-xs);
    }
    select {
      padding: var(--nexo-space-3) var(--nexo-space-12) var(--nexo-space-3) var(--nexo-space-4);
      background: var(--nexo-color-surface-2);
      border-radius: var(--nexo-radius-lg);
      font-weight: var(--nexo-font-weight-semibold);
      color: var(--nexo-color-text);
    }
    .reset-layout {
      width: var(--nexo-size-14);
      height: var(--nexo-size-14);
      border-radius: var(--nexo-radius-lg);
      background: var(--nexo-color-surface-2);
      color: var(--nexo-color-text);
      font-size: var(--nexo-font-size-xl);
      line-height: var(--nexo-line-height-none);
    }
    .reset-layout:disabled {
      opacity: var(--nexo-opacity-faint);
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
