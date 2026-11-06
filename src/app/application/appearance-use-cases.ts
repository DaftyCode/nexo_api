import { resolveVisualTemplate, VisualTemplateId } from '../domain/appearance';
import { PanelLayouts, resolvePanelLayouts } from '../domain/layout';

export interface AppearancePreferencesPort {
  loadTemplate(): unknown;
  saveTemplate(template: VisualTemplateId): void;
  loadLayout(): unknown;
  saveLayout(layouts: PanelLayouts): void;
}

export class AppearanceUseCases {
  constructor(private readonly preferences: AppearancePreferencesPort) {}

  current(): VisualTemplateId {
    return resolveVisualTemplate(this.preferences.loadTemplate());
  }

  select(value: unknown): VisualTemplateId {
    const template = resolveVisualTemplate(value);
    this.preferences.saveTemplate(template);
    return template;
  }

  /** Panel sizes the person chose for each template. */
  layouts(): PanelLayouts {
    return resolvePanelLayouts(this.preferences.loadLayout());
  }

  saveLayouts(layouts: PanelLayouts): void {
    this.preferences.saveLayout(resolvePanelLayouts(layouts));
  }
}
