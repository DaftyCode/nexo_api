import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserLanguage } from './browser-language';
describe('Browser language preferences', () => {
  it('works during server rendering without browser storage', () => {
    TestBed.configureTestingModule({
      providers: [BrowserLanguage, { provide: DOCUMENT, useValue: { defaultView: undefined } }],
    });
    const preferences = TestBed.inject(BrowserLanguage);
    expect(preferences.load()).toBeUndefined();
    expect(() => preferences.save('es')).not.toThrow();
  });
  it('tolerates storage restrictions', () => {
    const view = {
      get localStorage() {
        throw new Error('Storage blocked');
      },
    };
    TestBed.configureTestingModule({
      providers: [BrowserLanguage, { provide: DOCUMENT, useValue: { defaultView: view } }],
    });
    const preferences = TestBed.inject(BrowserLanguage);
    expect(preferences.load()).toBeUndefined();
    expect(() => preferences.save('es')).not.toThrow();
  });
});
