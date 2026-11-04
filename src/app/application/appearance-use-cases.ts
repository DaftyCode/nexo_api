import { resolveVisualTemplate, VisualTemplateId } from '../domain/appearance';

export interface AppearancePreferencesPort {
  loadTemplate(): unknown;
  saveTemplate(template: VisualTemplateId): void;
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
}
