import { Language, resolveLanguage } from '../domain/language';
export interface LanguagePreferencesPort {
  load(): unknown;
  save(language: Language): void;
}
export class LanguageUseCases {
  constructor(private readonly preferences: LanguagePreferencesPort) {}
  current(): Language {
    return resolveLanguage(this.preferences.load());
  }
  select(value: unknown): Language {
    const language = resolveLanguage(value);
    this.preferences.save(language);
    return language;
  }
}
