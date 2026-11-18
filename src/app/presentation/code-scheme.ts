import { computed, Injectable, Signal, signal } from '@angular/core';

/**
 * Whether the code editors are dark. The template in use decides, through `AppearanceState`;
 * until it answers, and outside the workspace, they stay dark.
 */
@Injectable({ providedIn: 'root' })
export class CodeScheme {
  private readonly source = signal<Signal<boolean> | undefined>(undefined);
  readonly dark = computed(() => this.source()?.() ?? true);

  /** Takes the answer from now on from `dark`. */
  follow(dark: Signal<boolean>) {
    this.source.set(dark);
  }
}
