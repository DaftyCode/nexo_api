import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../workspace-state';
import { SignInStore } from './sign-in-store';

interface Status {
  state: string;
  token?: unknown;
  error?: string;
}

function fixture(options: { window?: boolean; mode?: string; statuses?: Status[] } = {}) {
  const asked: string[] = [];
  const statuses = [...(options.statuses ?? [{ state: 'done', token: 't1' }])];
  let ended: (value: { outcome: string; url?: string }) => void = () => undefined;
  const oauth2 = {
    hasSignInWindow: !!options.window,
    oauth2Authorize: async () => ({ session: 's1', mode: options.mode ?? 'local', opened: false }),
    oauth2SignIn: async (_workspace: string, _session: string, action: string) => {
      asked.push(action);
      if (action === 'status') return statuses.shift() ?? { state: 'pending' };
      if (action === 'complete') return { state: 'done', token: 'pasted-url' };
      return {};
    },
    openSignInWindow: () =>
      new Promise<{ outcome: string; url?: string }>((done) => {
        ended = done;
      }),
    closeSignInWindow: async () => void asked.push('close'),
    addOAuth2Token: async () => 'added',
  };
  const completed: string[] = [];
  const state = {
    cases: { oauth2 },
    workspaceId: () => 'w',
    error: signal(''),
    describe: (error: unknown) => (error as Error).message,
    completeOAuth2SignIn: async (url: string) => void completed.push(url),
    cancelOAuth2SignIn: async () => void completed.push('cancelled'),
  } as unknown as WorkspaceState;
  const store = new SignInStore(state);
  return {
    store,
    asked,
    state,
    completed,
    end: (value: { outcome: string; url?: string }) => ended(value),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the OAuth 2.0 sign-in in progress', () => {
  it('waits in the system browser until it gives a token', async () => {
    const { store, asked } = fixture({
      statuses: [{ state: 'pending' }, { state: 'done', token: 'abc' }],
    });
    const running = store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await running).toBe('abc');
    expect(asked.filter((action) => action === 'status')).toHaveLength(2);
    expect(store.current()).toBeUndefined();
  });

  it('opens the system browser from the desktop app for a relay, and stops on a failure', async () => {
    const { store, asked } = fixture({
      window: true,
      mode: 'relay',
      statuses: [{ state: 'error' }],
    });
    const running = store.run({}, {} as never).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(800);
    expect(await running).toBe('The sign-in failed');
    expect(asked[0]).toBe('open');
  });

  it('ends when cancelled, and when another sign-in took its place', async () => {
    const cancelled = fixture({ statuses: [{ state: 'cancelled' }] });
    const running = cancelled.store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(800);
    expect(await running).toBeUndefined();

    const replaced = fixture({ statuses: [] });
    const first = replaced.store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(10);
    replaced.store.current.set({ session: 'other' } as never);
    await vi.advanceTimersByTimeAsync(800);
    expect(await first).toBeUndefined();
  });

  it('takes the address the sign-in window returned to, or cancels when it is closed', async () => {
    const returned = fixture({ window: true, statuses: [] });
    const running = returned.store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(10);
    returned.end({ outcome: 'returned', url: 'https://cb.test/?code=1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(returned.completed).toEqual(['https://cb.test/?code=1']);
    returned.store.current.set(undefined);
    await vi.advanceTimersByTimeAsync(800);
    await running;
    expect(returned.asked).toContain('close');

    const closed = fixture({ window: true, statuses: [] });
    void closed.store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(10);
    closed.end({ outcome: 'closed' });
    await vi.advanceTimersByTimeAsync(10);
    expect(closed.completed).toEqual(['cancelled']);
    await closed.store.reopen();
    await closed.store.cancel();
    expect(closed.store.current()).toBeUndefined();
  });

  it('completes with a pasted address or token, reopens and cancels', async () => {
    const { store, asked } = fixture({ statuses: [] });
    await store.complete('ignored');
    await store.usePasted({ accessToken: 'x' } as never);
    await store.reopen();
    await store.cancel();
    expect(asked).toEqual([]);
    const running = store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(10);
    await store.reopen();
    expect(asked).toContain('open');
    await store.complete(' https://cb.test/?code=2 ');
    await vi.advanceTimersByTimeAsync(800);
    expect(await running).toBe('pasted-url');

    const pasted = store.run({}, {} as never);
    await vi.advanceTimersByTimeAsync(10);
    store.tokenName = 'mine';
    await store.usePasted({ accessToken: 'x' } as never);
    await vi.advanceTimersByTimeAsync(800);
    expect(await pasted).toBe('added');
    expect(asked).toContain('cancel');
  });
});
