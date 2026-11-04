import { afterNextRender, computed, effect, inject, Injectable, signal } from '@angular/core';
import { APPEARANCE } from '../composition/providers';
import {
  defaultVisualTemplate,
  resolveVisualTemplate,
  VisualTemplateId,
} from '../domain/appearance';

@Injectable({ providedIn: 'root' })
export class AppearanceState {
  private readonly cases = inject(APPEARANCE);
  private readonly initialized = signal(false);
  readonly model = signal<{ template: VisualTemplateId }>({ template: defaultVisualTemplate });
  readonly current = computed(() => resolveVisualTemplate(this.model().template));

  constructor() {
    afterNextRender(() => {
      this.model.set({ template: this.cases.current() });
      this.initialized.set(true);
    });
    effect(() => {
      if (this.initialized()) this.cases.select(this.current());
    });
  }
}
