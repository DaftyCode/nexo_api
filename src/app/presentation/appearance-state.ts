import { afterNextRender, computed, effect, inject, Injectable, signal } from '@angular/core';
import { APPEARANCE } from '../composition/providers';
import {
  defaultVisualTemplate,
  resolveVisualTemplate,
  VisualTemplateId,
} from '../domain/appearance';
import { PanelLayout, PanelLayouts, PanelName, resizePanel } from '../domain/layout';
import { moveWithin } from '../domain/ordering';
import { sectionIds, workspaceSections } from './workspace/sections';

@Injectable({ providedIn: 'root' })
export class AppearanceState {
  private readonly cases = inject(APPEARANCE);
  private readonly initialized = signal(false);
  readonly model = signal<{ template: VisualTemplateId }>({ template: defaultVisualTemplate });
  readonly current = computed(() => resolveVisualTemplate(this.model().template));
  private readonly layouts = signal<PanelLayouts>({});
  /** Panel sizes of the current template; missing ones keep the template's own. */
  readonly layout = computed<PanelLayout>(() => this.layouts()[this.current()] ?? {});
  /** Ids of the side menu sections, in the order the person dragged them to. */
  private readonly sectionOrder = signal<readonly string[]>(sectionIds);
  /** The side menu sections, in that order. */
  readonly sections = computed(() =>
    this.sectionOrder().flatMap((id) => workspaceSections.filter((s) => s.id === id)),
  );
  /** Whether the side menu is in an order of the person's own. */
  readonly sectionsMoved = computed(() =>
    this.sectionOrder().some((id, index) => id !== sectionIds[index]),
  );

  constructor() {
    afterNextRender(() => {
      this.model.set({ template: this.cases.current() });
      this.layouts.set(this.cases.layouts());
      this.sectionOrder.set(this.cases.sectionOrder(sectionIds));
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
  /** Whether a panel of the current template was resized. */
  readonly resized = computed(() => Object.keys(this.layout()).length > 0);
  /** "Reset layout": every panel of the current template back to its size. */
  resetLayout() {
    this.layouts.update((layouts) => ({ ...layouts, [this.current()]: {} }));
    this.save();
  }
  /** Moves a section of the side menu to a position counted before the move, and keeps it. */
  moveSection(id: string, to: number) {
    const order = this.sectionOrder();
    const next = moveWithin(order, order.indexOf(id), to);
    this.sectionOrder.set(this.cases.saveSectionOrder(next, sectionIds));
  }
  /** The side menu back to its default order. */
  resetSections() {
    this.sectionOrder.set(this.cases.saveSectionOrder([], sectionIds));
  }
  /** Keeps the sizes once a drag ends. */
  save() {
    this.cases.saveLayouts(this.layouts());
  }
}
