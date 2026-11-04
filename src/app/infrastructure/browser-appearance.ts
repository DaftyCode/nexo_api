import { DOCUMENT, inject, Injectable } from '@angular/core';
import { AppearancePreferencesPort } from '../application/appearance-use-cases';
import { VisualTemplateId } from '../domain/appearance';

const preferenceKey = 'nexo.appearance.template';

@Injectable()
export class BrowserAppearance implements AppearancePreferencesPort {
  private readonly document = inject(DOCUMENT);

  loadTemplate(): unknown {
    try {
      return this.document.defaultView?.localStorage.getItem(preferenceKey);
    } catch {
      return undefined;
    }
  }

  saveTemplate(template: VisualTemplateId): void {
    try {
      this.document.defaultView?.localStorage.setItem(preferenceKey, template);
    } catch {
      // A restricted storage policy must not prevent switching the current view.
    }
  }
}
