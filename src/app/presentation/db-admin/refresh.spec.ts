import { DestroyRef } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoRefresh } from './refresh';

describe('AutoRefresh', () => {
  afterEach(() => vi.useRealTimers());

  it('reads again every few seconds, never twice at once, and stops when destroyed', async () => {
    vi.useFakeTimers();
    let destroyed: () => void = () => undefined;
    const destroy = {
      onDestroy: (done: () => void) => (destroyed = done),
    } as unknown as DestroyRef;
    let reads = 0;
    let finish: () => void = () => undefined;
    const refresh = new AutoRefresh(() => {
      reads++;
      return new Promise<void>((done) => (finish = done));
    }, destroy);
    refresh.set(2);
    expect(refresh.every()).toBe(2);
    await vi.advanceTimersByTimeAsync(6_100);
    expect(reads).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    finish();
    destroyed();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(2);
    refresh.set(0);
    expect(refresh.every()).toBe(0);
  });
});
