import { LanguageUseCases } from './language-use-cases';
describe('Language preferences', () => {
  it('defaults to English, validates input and restores the saved choice', () => {
    let stored: unknown;
    const preferences = {
      load: () => stored,
      save: (value: string) => {
        stored = value;
      },
    };
    const cases = new LanguageUseCases(preferences);
    expect(cases.current()).toBe('en');
    expect(cases.select('es')).toBe('es');
    expect(new LanguageUseCases(preferences).current()).toBe('es');
    expect(cases.select('unrecognized')).toBe('en');
  });
});
