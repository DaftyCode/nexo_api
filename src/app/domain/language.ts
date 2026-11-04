export const languages = ['en', 'es'] as const;
export type Language = (typeof languages)[number];
export function resolveLanguage(value: unknown): Language {
  return value === 'es' ? 'es' : 'en';
}
