import { VisualTemplateId, visualTemplates } from './appearance';

/**
 * Sizes, in pixels, the person gave to the workspace panels by dragging their dividers.
 * A missing size keeps the template's own.
 */
export interface PanelLayout {
  /** Width of the collections sidebar (or of the whole navigation, where it holds the rail). */
  sidebar?: number;
  /** Height of the request configuration above the response. */
  request?: number;
  /** Width of the request column when request and response sit side by side. */
  split?: number;
  /** Width of the context panel on the right. */
  context?: number;
}
export type PanelName = keyof PanelLayout;
/** One layout per template: their panels differ in place and default size. */
export type PanelLayouts = Partial<Record<VisualTemplateId, PanelLayout>>;

const limits: Record<PanelName, readonly [number, number]> = {
  sidebar: [160, 640],
  request: [90, 2000],
  split: [280, 2400],
  context: [200, 640],
};

/** A panel size within its limits, in whole pixels. */
export function clampPanel(name: PanelName, size: number): number {
  const [min, max] = limits[name];
  return Math.round(Math.min(max, Math.max(min, size)));
}

/** Stored layouts, keeping only known templates, panels and finite sizes. */
export function resolvePanelLayouts(value: unknown): PanelLayouts {
  if (!value || typeof value !== 'object') return {};
  const layouts: PanelLayouts = {};
  for (const { id } of visualTemplates) {
    const stored = (value as Record<string, unknown>)[id];
    if (!stored || typeof stored !== 'object') continue;
    const layout: PanelLayout = {};
    for (const name of Object.keys(limits) as PanelName[]) {
      const size = (stored as Record<string, unknown>)[name];
      if (typeof size === 'number' && Number.isFinite(size)) layout[name] = clampPanel(name, size);
    }
    if (Object.keys(layout).length) layouts[id] = layout;
  }
  return layouts;
}

/** The layouts with one panel resized, or back to the template size without `size`. */
export function resizePanel(
  layouts: PanelLayouts,
  template: VisualTemplateId,
  name: PanelName,
  size?: number,
): PanelLayouts {
  const { [name]: _previous, ...rest } = layouts[template] ?? {};
  const layout: PanelLayout =
    size === undefined ? rest : { ...rest, [name]: clampPanel(name, size) };
  return { ...layouts, [template]: layout };
}

/**
 * The workspace sections in the order the person dragged them to: known sections only, each
 * once, and sections added since then at their default place after the others.
 */
export function resolveSectionOrder(value: unknown, sections: readonly string[]): string[] {
  const stored = Array.isArray(value) ? value : [];
  const kept = [...new Set(stored.filter((id): id is string => sections.includes(id)))];
  return [...kept, ...sections.filter((id) => !kept.includes(id))];
}
