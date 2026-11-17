import { SqlTemplate, readTemplates } from '../../domain/db/sql-templates';
import { PreferencePort } from '../ports';

const TEMPLATES = 'db.templates';
const PARAMETERS = 'db.parameters';
/** Parameter values remembered, by name. */
const REMEMBERED = 100;

/**
 * What helps writing SQL and is kept on this computer: the person's own templates, and the
 * last value given to each named parameter.
 */
export class DatabaseAssistCases {
  constructor(private readonly preferences: PreferencePort) {}

  templates(): SqlTemplate[] {
    return readTemplates(this.preferences.read(TEMPLATES));
  }
  setTemplates(templates: readonly SqlTemplate[]) {
    this.preferences.write(TEMPLATES, JSON.stringify(templates));
  }

  /** The last value each parameter was given. */
  parameters(): Record<string, string> {
    try {
      const stored: unknown = JSON.parse(this.preferences.read(PARAMETERS) ?? '{}');
      return Object.fromEntries(
        Object.entries((stored ?? {}) as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  }
  remember(values: Readonly<Record<string, string>>) {
    const all = Object.entries({ ...this.parameters(), ...values }).slice(-REMEMBERED);
    this.preferences.write(PARAMETERS, JSON.stringify(Object.fromEntries(all)));
  }
}
