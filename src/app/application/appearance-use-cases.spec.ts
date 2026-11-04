import { AppearanceUseCases } from './appearance-use-cases';

describe('Appearance preferences', () => {
  it('opens new installations with Aurora and ignores unknown stored templates', () => {
    for (const stored of [undefined, 'unknown', 'classic', { id: 'studio' }]) {
      const cases = new AppearanceUseCases({ loadTemplate: () => stored, saveTemplate() {} });
      expect(cases.current()).toBe('aurora');
    }
  });

  it('persists Studio and restores it in a new application session', () => {
    let stored: unknown;
    const preferences = {
      loadTemplate: () => stored,
      saveTemplate: (value: unknown) => {
        stored = value;
      },
    };
    const first = new AppearanceUseCases(preferences);
    expect(first.select('studio')).toBe('studio');
    expect(new AppearanceUseCases(preferences).current()).toBe('studio');
    first.select('aurora');
    expect(new AppearanceUseCases(preferences).current()).toBe('aurora');
  });
});
