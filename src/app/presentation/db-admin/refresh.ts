import { DestroyRef, signal } from '@angular/core';

/** How often a view of the server may read itself again, in seconds; 0 is never. */
export const REFRESH_EVERY = [0, 2, 5, 10, 30] as const;

/**
 * Reads a view of the server again every few seconds, as DBeaver's session manager does,
 * until another period is chosen or the view goes away. A read still running is not
 * started again.
 */
export class AutoRefresh {
  readonly every = signal(0);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly read: () => Promise<unknown>,
    destroy: DestroyRef,
  ) {
    destroy.onDestroy(() => this.stop());
  }

  set(seconds: number) {
    this.stop();
    this.every.set(seconds);
    if (seconds > 0) this.timer = setInterval(() => void this.tick(), seconds * 1000);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.read();
    } finally {
      this.running = false;
    }
  }

  private stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
