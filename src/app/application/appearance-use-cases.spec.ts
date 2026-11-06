import { AppearanceUseCases } from './appearance-use-cases';

describe('Appearance preferences', () => {
  it('opens new installations with Aurora and ignores unknown stored templates', () => {
    for (const stored of [undefined, 'unknown', 'classic', { id: 'studio' }]) {
      const cases = new AppearanceUseCases({
        loadTemplate: () => stored,
        saveTemplate() {},
        loadLayout: () => undefined,
        saveLayout() {},
      });
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
      loadLayout: () => undefined,
      saveLayout() {},
    };
    const first = new AppearanceUseCases(preferences);
    expect(first.select('studio')).toBe('studio');
    expect(new AppearanceUseCases(preferences).current()).toBe('studio');
    first.select('aurora');
    expect(new AppearanceUseCases(preferences).current()).toBe('aurora');
  });

  it('keeps the panel sizes of each template within their limits', () => {
    let stored: unknown;
    const cases = new AppearanceUseCases({
      loadTemplate: () => 'aurora',
      saveTemplate() {},
      loadLayout: () => stored,
      saveLayout: (value) => {
        stored = JSON.parse(JSON.stringify(value));
      },
    });
    expect(cases.layouts()).toEqual({});
    cases.saveLayouts({ aurora: { sidebar: 320.4, request: 10 }, studio: { context: 5000 } });
    expect(cases.layouts()).toEqual({
      aurora: { sidebar: 320, request: 90 },
      studio: { context: 640 },
    });
    stored = { aurora: { sidebar: 'wide', split: Infinity }, other: { sidebar: 300 } };
    expect(cases.layouts()).toEqual({});
  });
});
