import { TestBed } from '@angular/core/testing';
import { AppearanceUseCases } from '../application/appearance-use-cases';
import { APPEARANCE } from '../composition/providers';
import { AppearanceState } from './appearance-state';
import { CodeScheme } from './code-scheme';

/** The appearance of one start of the app, over what the previous one stored. */
function start(stored: { template?: unknown; layout?: unknown }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: APPEARANCE,
        useValue: new AppearanceUseCases({
          loadTemplate: () => stored.template,
          saveTemplate: (template) => (stored.template = template),
          loadLayout: () => stored.layout,
          saveLayout: (layout) => (stored.layout = JSON.parse(JSON.stringify(layout))),
          loadSections: () => undefined,
          saveSections() {},
        }),
      },
    ],
  });
  return TestBed.inject(AppearanceState);
}

describe('AppearanceState', () => {
  it('opens a new installation with the light Aurora and its light code editors', () => {
    const appearance = start({});
    expect(appearance.current()).toBe('aurora');
    expect(appearance.arrangement()).toBe('aurora');
    expect(appearance.darkCode()).toBe(false);
    expect(TestBed.inject(CodeScheme).dark()).toBe(false);
  });

  it('opens with the template it was closed on, from the first moment', () => {
    const stored: { template?: unknown } = {};
    let appearance = start(stored);
    TestBed.tick();
    for (const template of ['canvas', 'aurora-color'] as const) {
      appearance.model.set({ template });
      TestBed.tick();
      expect(stored.template).toBe(template);
      appearance = start(stored);
      expect(appearance.current()).toBe(template);
    }
    expect(appearance.arrangement()).toBe('aurora');
    expect(TestBed.inject(CodeScheme).dark()).toBe(true);
  });

  it('gives both Aurora templates the same panel sizes', () => {
    const stored: { layout?: unknown } = { layout: { aurora: { sidebar: 300 } } };
    const appearance = start(stored);
    expect(appearance.layout()).toEqual({ sidebar: 300 });
    appearance.model.set({ template: 'aurora-color' });
    expect(appearance.layout()).toEqual({ sidebar: 300 });
    appearance.resize('sidebar', 350);
    appearance.save();
    expect(stored.layout).toEqual({ aurora: { sidebar: 350 } });
    appearance.model.set({ template: 'studio' });
    expect(appearance.resized()).toBe(false);
    appearance.model.set({ template: 'aurora' });
    expect(appearance.layout()).toEqual({ sidebar: 350 });
    appearance.reset('sidebar');
    expect(appearance.resized()).toBe(false);
    expect(stored.layout).toEqual({});
  });
});
