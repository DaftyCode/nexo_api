/** How a template lays out the workspace; templates that differ only in colour share one. */
export const templateArrangements = ['aurora', 'studio', 'canvas'] as const;
export type TemplateArrangement = (typeof templateArrangements)[number];

interface VisualTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly arrangement: TemplateArrangement;
  /** Whether its code editors are dark; the light Aurora has light ones. */
  readonly darkCode: boolean;
}

/** The templates of the selector, in its order; the first one is the default. */
export const visualTemplates = [
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Light workspace on a white background',
    arrangement: 'aurora',
    darkCode: false,
  },
  {
    id: 'aurora-color',
    name: 'Aurora full color',
    description: 'Blue and violet studio',
    arrangement: 'aurora',
    darkCode: true,
  },
  {
    id: 'studio',
    name: 'Studio',
    description: 'Three-column workspace with live context',
    arrangement: 'studio',
    darkCode: true,
  },
  {
    id: 'canvas',
    name: 'Canvas',
    description: 'Light workspace with request and response side by side',
    arrangement: 'canvas',
    darkCode: true,
  },
] as const satisfies readonly VisualTemplate[];

export type VisualTemplateId = (typeof visualTemplates)[number]['id'];
export const defaultVisualTemplate: VisualTemplateId = visualTemplates[0].id;

/** The template with that id, or the default one for anything else. */
export function visualTemplate(value: unknown): (typeof visualTemplates)[number] {
  return visualTemplates.find((template) => template.id === value) ?? visualTemplates[0];
}

export function resolveVisualTemplate(value: unknown): VisualTemplateId {
  return visualTemplate(value).id;
}
