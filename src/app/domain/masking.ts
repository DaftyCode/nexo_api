/**
 * Masking sets (`masking` documents, B-06): rules that hide or replace sensitive fields
 * before data leaves Nexo. The backend applies them (`mask.apply`) with a key of the
 * workspace that never leaves it; here are the forms and what each rule says.
 */
export type MaskMethod = 'hide' | 'truncate' | 'hash' | 'synthetic' | 'remove';
export const MASK_METHODS: readonly MaskMethod[] = [
  'hide',
  'truncate',
  'hash',
  'synthetic',
  'remove',
];
/** Characters `truncate` keeps at most, and by default. */
export const MAX_KEEP = 12;
export const DEFAULT_KEEP = 4;
/** Rules of one set, at most (as the backend checks). */
export const MAX_MASK_RULES = 200;

export interface MaskRule {
  path: string;
  method: MaskMethod;
  /** `truncate`: the last characters it shows. */
  keep: number;
}

export interface MaskingSet {
  id: string;
  name: string;
  /** Whether MCP agents (and the AI assistant) read through this set too. */
  agents: boolean;
  rules: MaskRule[];
}

/** What the person edits. */
export interface MaskingForm {
  name: string;
  agents: boolean;
  rules: MaskRule[];
}

export const emptyRule = (): MaskRule => ({ path: '', method: 'hide', keep: DEFAULT_KEEP });

export function emptyMaskingForm(): MaskingForm {
  return { name: '', agents: false, rules: [emptyRule()] };
}

const method = (value: unknown): MaskMethod =>
  MASK_METHODS.find((known) => known === value) ?? 'hide';

/** A set from its document; anything else reads as none. */
export function readMaskingSet(document: {
  id: string;
  kind: string;
  name: string;
  value?: unknown;
}): MaskingSet | undefined {
  if (document.kind !== 'masking') return undefined;
  const value = (document.value ?? {}) as { agents?: unknown; rules?: unknown };
  const rules = Array.isArray(value.rules) ? value.rules : [];
  return {
    id: document.id,
    name: document.name,
    agents: value.agents === true,
    rules: rules.map((rule) => {
      const read = (rule ?? {}) as { path?: unknown; method?: unknown; keep?: unknown };
      return {
        path: typeof read.path === 'string' ? read.path : '',
        method: method(read.method),
        keep: typeof read.keep === 'number' ? read.keep : DEFAULT_KEEP,
      };
    }),
  };
}

export function maskingForm(set: MaskingSet): MaskingForm {
  return {
    name: set.name,
    agents: set.agents,
    rules: set.rules.length ? set.rules.map((rule) => ({ ...rule })) : [emptyRule()],
  };
}

/** The rules as the backend reads them: without the empty ones, `keep` only to truncate. */
export interface StoredRule {
  path: string;
  method: MaskMethod;
  keep?: number;
}
export function maskingRules(rules: readonly MaskRule[]): StoredRule[] {
  return rules
    .filter((rule) => rule.path.trim())
    .map((rule) => ({
      path: rule.path.trim(),
      method: rule.method,
      ...(rule.method === 'truncate' ? { keep: Math.trunc(Number(rule.keep) || 0) } : {}),
    }));
}

/** The value of a set's document. */
export function maskingValue(form: MaskingForm) {
  return { agents: form.agents, rules: maskingRules(form.rules) };
}

/** What keeps a form from being saved, as a message to translate; none when it can be. */
export function maskingProblem(form: MaskingForm): string | undefined {
  if (!form.name.trim()) return 'Name the masking set';
  const rules = maskingRules(form.rules);
  if (!rules.length) return 'Add a rule with the path of a field';
  if (rules.length > MAX_MASK_RULES) return 'A masking set has 200 rules at most';
  if (rules.some((rule) => rule.keep !== undefined && (rule.keep < 0 || rule.keep > MAX_KEEP)))
    return 'Truncate keeps from 0 to 12 characters';
  return undefined;
}

/** An example to try a set on, with the fields that usually need masking. */
export const MASKING_SAMPLE = JSON.stringify(
  [
    {
      id: 1,
      name: 'Ana Real',
      email: 'ana.real@example.org',
      phone: '+34 600 123 456',
      card: { number: '4111 1111 1111 1234', expires: '2029-04' },
      password: 'hunter2',
    },
  ],
  null,
  2,
);
