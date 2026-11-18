import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { APPEARANCE } from '../composition/providers';
import { resolveVisualTemplate, visualTemplate, VisualTemplateId } from '../domain/appearance';
import { PanelLayout, PanelLayouts, PanelName, resizePanel } from '../domain/layout';
import { moveWithin } from '../domain/ordering';
import { CodeScheme } from './code-scheme';
import { sectionIds, workspaceSections } from './workspace/sections';

@Injectable({ providedIn: 'root' })
export class AppearanceState {
  private readonly cases = inject(APPEARANCE);
  /** The template chosen last time, read before the first paint so the app opens with it. */
  readonly model = signal<{ template: VisualTemplateId }>({ template: this.cases.current() });
  readonly current = computed(() => resolveVisualTemplate(this.model().template));
  /** How the current template lays out the workspace (`data-template` of the workspace). */
  readonly arrangement = computed(() => visualTemplate(this.current()).arrangement);
  /** Whether the code editors of the current template are dark. */
  readonly darkCode = computed(() => visualTemplate(this.current()).darkCode);
  private readonly layouts = signal<PanelLayouts>(this.cases.layouts());
  /** Panel sizes of the current arrangement; missing ones keep the template's own. */
  readonly layout = computed<PanelLayout>(() => this.layouts()[this.arrangement()] ?? {});
  /** Ids of the side menu sections, in the order the person dragged them to. */
  private readonly sectionOrder = signal<readonly string[]>(this.cases.sectionOrder(sectionIds));
  /** The side menu sections, in that order. */
  readonly sections = computed(() =>
    this.sectionOrder().flatMap((id) => workspaceSections.filter((s) => s.id === id)),
  );
  /** Whether the side menu is in an order of the person's own. */
  readonly sectionsMoved = computed(() =>
    this.sectionOrder().some((id, index) => id !== sectionIds[index]),
  );

  constructor() {
    inject(CodeScheme).follow(this.darkCode);
    // Every change is kept at once, so closing the app on a template opens it there next time.
    effect(() => this.cases.select(this.current()));
  }

  /** Resizes a panel of the current template while its divider is dragged. */
  resize(name: PanelName, size: number) {
    this.layouts.update((layouts) => resizePanel(layouts, this.arrangement(), name, size));
  }
  /** Gives a panel back its template size. */
  reset(name: PanelName) {
    this.layouts.update((layouts) => resizePanel(layouts, this.arrangement(), name));
    this.save();
  }
  /** Whether a panel of the current arrangement was resized. */
  readonly resized = computed(() => Object.keys(this.layout()).length > 0);
  /** "Reset layout": every panel of the current template back to its size. */
  resetLayout() {
    this.layouts.update((layouts) => ({ ...layouts, [this.arrangement()]: {} }));
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
