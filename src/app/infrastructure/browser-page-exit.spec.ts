import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPageExit } from './browser-page-exit';
import { HttpApi } from './http-api';

const pageEvent = (type: string, persisted = false) =>
  Object.assign(new Event(type), { persisted }) as PageTransitionEvent;

describe('BrowserPageExit', () => {
  let exit: BrowserPageExit;
  let restart: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [HttpApi, BrowserPageExit, provideHttpClient()] });
    exit = TestBed.inject(BrowserPageExit);
    restart = vi.fn<() => void>();
    vi.spyOn(exit as unknown as { restart: () => void }, 'restart').mockImplementation(restart);
  });
  afterEach(() => vi.restoreAllMocks());

  it('leaves when the page hides, and starts again if it comes back after closing something', () => {
    const answers = [false, true];
    const leave = vi.fn(() => answers.shift() ?? false);
    exit.onExit(leave);

    globalThis.dispatchEvent(pageEvent('pagehide'));
    globalThis.dispatchEvent(pageEvent('pageshow', true));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();

    globalThis.dispatchEvent(pageEvent('pagehide'));
    globalThis.dispatchEvent(pageEvent('pageshow'));
    expect(restart).not.toHaveBeenCalled();
    globalThis.dispatchEvent(pageEvent('pageshow', true));
    expect(restart).toHaveBeenCalledTimes(1);
    globalThis.dispatchEvent(pageEvent('pageshow', true));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('sends what the page asks with the request that outlives it', () => {
    const send = vi.spyOn(TestBed.inject(HttpApi), 'executeOnExit').mockImplementation(() => {});
    exit.send('db.disconnect', { session: 'tree:c1', workspace: 'w' });
    expect(send).toHaveBeenCalledWith('db.disconnect', { session: 'tree:c1', workspace: 'w' });
  });
});
