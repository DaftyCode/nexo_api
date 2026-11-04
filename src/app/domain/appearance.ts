export const visualTemplates = [
  { id: 'aurora', name: 'Aurora', description: 'Blue and violet studio' },
  { id: 'studio', name: 'Studio', description: 'Three-column workspace with live context' },
  {
    id: 'canvas',
    name: 'Canvas',
    description: 'Light workspace with request and response side by side',
  },
] as const;

export type VisualTemplateId = (typeof visualTemplates)[number]['id'];
export const defaultVisualTemplate: VisualTemplateId = 'aurora';

export function resolveVisualTemplate(value: unknown): VisualTemplateId {
  return visualTemplates.find((template) => template.id === value)?.id ?? defaultVisualTemplate;
}
