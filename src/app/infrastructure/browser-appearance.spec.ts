import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserAppearance } from './browser-appearance';

describe('Browser appearance storage', () => {
  it('works without a browser window during server rendering', () => {
    TestBed.configureTestingModule({
      providers: [BrowserAppearance, { provide: DOCUMENT, useValue: { defaultView: undefined } }],
    });
    const preferences = TestBed.inject(BrowserAppearance);
    expect(preferences.loadTemplate()).toBeUndefined();
    expect(() => preferences.saveTemplate('studio')).not.toThrow();
  });

  it('keeps the UI usable when local storage is restricted', () => {
    const blocked = () => {
      throw new Error('Storage blocked');
    };
    TestBed.configureTestingModule({
      providers: [
        BrowserAppearance,
        {
          provide: DOCUMENT,
          useValue: { defaultView: { localStorage: { getItem: blocked, setItem: blocked } } },
        },
      ],
    });
    const preferences = TestBed.inject(BrowserAppearance);
    expect(preferences.loadTemplate()).toBeUndefined();
    expect(() => preferences.saveTemplate('aurora')).not.toThrow();
  });
});
