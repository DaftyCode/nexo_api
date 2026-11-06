import { afterNextRender, computed, effect, inject, Injectable, signal } from '@angular/core';
import { APPEARANCE } from '../composition/providers';
import {
  defaultVisualTemplate,
  resolveVisualTemplate,
  VisualTemplateId,
} from '../domain/appearance';
import { PanelLayout, PanelLayouts, PanelName, resizePanel } from '../domain/layout';

@Injectable({ providedIn: 'root' })
export class AppearanceState {
  private readonly cases = inject(APPEARANCE);
  private readonly initialized = signal(false);
  readonly model = signal<{ template: VisualTemplateId }>({ template: defaultVisualTemplate });
  readonly current = computed(() => resolveVisualTemplate(this.model().template));
  private readonly layouts = signal<PanelLayouts>({});
  /** Panel sizes of the current template; missing ones keep the template's own. */
  readonly layout = computed<PanelLayout>(() => this.layouts()[this.current()] ?? {});

  constructor() {
    afterNextRender(() => {
      this.model.set({ template: this.cases.current() });
      this.layouts.set(this.cases.layouts());
      this.initialized.set(true);
    });
    effect(() => {
      if (this.initialized()) this.cases.select(this.current());
    });
  }

  /** Resizes a panel of the current template while its divider is dragged. */
  resize(name: PanelName, size: number) {
    this.layouts.update((layouts) => resizePanel(layouts, this.current(), name, size));
  }
  /** Gives a panel back its template size. */
  reset(name: PanelName) {
    this.layouts.update((layouts) => resizePanel(layouts, this.current(), name));
    this.save();
  }
  /** Keeps the sizes once a drag ends. */
  save() {
    this.cases.saveLayouts(this.layouts());
  }
}
