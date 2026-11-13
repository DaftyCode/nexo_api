import { resolveVisualTemplate, VisualTemplateId } from '../domain/appearance';
import { PanelLayouts, resolvePanelLayouts, resolveSectionOrder } from '../domain/layout';

export interface AppearancePreferencesPort {
  loadTemplate(): unknown;
  saveTemplate(template: VisualTemplateId): void;
  loadLayout(): unknown;
  saveLayout(layouts: PanelLayouts): void;
  loadSections(): unknown;
  /** An empty list goes back to the default order. */
  saveSections(order: readonly string[]): void;
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

  /** The workspace sections of the side menu, in the order the person gave them. */
  sectionOrder(sections: readonly string[]): string[] {
    return resolveSectionOrder(this.preferences.loadSections(), sections);
  }

  /** Keeps the order of the sections; the default order is kept as no order at all. */
  saveSectionOrder(order: readonly string[], sections: readonly string[]): string[] {
    const resolved = resolveSectionOrder(order, sections);
    const changed = resolved.some((id, index) => id !== sections[index]);
    this.preferences.saveSections(changed ? resolved : []);
    return resolved;
  }
}
