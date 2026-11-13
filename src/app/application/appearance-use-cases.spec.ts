import { AppearanceUseCases } from './appearance-use-cases';

describe('Appearance preferences', () => {
  it('opens new installations with Aurora and ignores unknown stored templates', () => {
    for (const stored of [undefined, 'unknown', 'classic', { id: 'studio' }]) {
      const cases = new AppearanceUseCases({
        loadTemplate: () => stored,
        saveTemplate() {},
        loadLayout: () => undefined,
        saveLayout() {},
        loadSections: () => undefined,
        saveSections() {},
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
      loadSections: () => undefined,
      saveSections() {},
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
      loadSections: () => undefined,
      saveSections() {},
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

  it('keeps the order of the side menu, with new sections after the others', () => {
    let stored: unknown;
    const cases = new AppearanceUseCases({
      loadTemplate: () => 'aurora',
      saveTemplate() {},
      loadLayout: () => undefined,
      saveLayout() {},
      loadSections: () => stored,
      saveSections: (order) => {
        stored = [...order];
      },
    });
    const sections = ['collections', 'history', 'git'];
    expect(cases.sectionOrder(sections)).toEqual(sections);
    expect(cases.saveSectionOrder(['git', 'collections', 'history'], sections)).toEqual([
      'git',
      'collections',
      'history',
    ]);
    expect(cases.sectionOrder([...sections, 'mongo'])).toEqual([
      'git',
      'collections',
      'history',
      'mongo',
    ]);
    stored = ['gone', 'history', 'history', 42];
    expect(cases.sectionOrder(sections)).toEqual(['history', 'collections', 'git']);
    // The default order is stored as no order, so later defaults apply.
    cases.saveSectionOrder(sections, sections);
    expect(stored).toEqual([]);
  });
});
