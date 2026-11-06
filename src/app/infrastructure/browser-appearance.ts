import { DOCUMENT, inject, Injectable } from '@angular/core';
import { AppearancePreferencesPort } from '../application/appearance-use-cases';
import { VisualTemplateId } from '../domain/appearance';
import { PanelLayouts } from '../domain/layout';

const preferenceKey = 'nexo.appearance.template';
const layoutKey = 'nexo.appearance.layout';

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

  loadLayout(): unknown {
    try {
      const text = this.document.defaultView?.localStorage.getItem(layoutKey);
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  saveLayout(layouts: PanelLayouts): void {
    try {
      this.document.defaultView?.localStorage.setItem(layoutKey, JSON.stringify(layouts));
    } catch {
      // Panel sizes are a convenience: without storage they last until the page closes.
    }
  }
}
