import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CodeScheme } from './code-scheme';

describe('CodeScheme', () => {
  it('keeps the code editors dark until a template answers, then follows it', () => {
    const scheme = TestBed.inject(CodeScheme);
    expect(scheme.dark()).toBe(true);
    const dark = signal(false);
    scheme.follow(dark);
    expect(scheme.dark()).toBe(false);
    dark.set(true);
    expect(scheme.dark()).toBe(true);
  });
});
