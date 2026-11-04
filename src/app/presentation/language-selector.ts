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
      padding: 7px 24px 7px 9px;
      font-size: 11px;
      border-radius: 8px;
      color: var(--text);
      background: var(--panel-2);
      max-width: 110px;
    }
  `,
})
export class LanguageSelector {
  protected readonly language = inject(LanguageState);
  protected readonly fields = form(this.language.model);
}
