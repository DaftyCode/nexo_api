import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { LanguageState } from './language-state';
@Component({
  selector: 'app-language-selector',
  imports: [FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<select [formField]="fields.language" aria-label="Language / Idioma">
    <option value="en" lang="en">English</option>
    <option value="es" lang="es">Español</option>
  </select>`,
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
    }
    select {
      padding: var(--nexo-space-3) var(--nexo-space-12) var(--nexo-space-3) var(--nexo-space-4);
      font-size: var(--nexo-font-size-xs);
      border-radius: var(--nexo-radius-lg);
      color: var(--nexo-color-text);
      background: var(--nexo-color-surface-2);
      max-width: 110px;
    }
  `,
})
export class LanguageSelector {
  protected readonly language = inject(LanguageState);
  protected readonly fields = form(this.language.model);
}
