/**
 * The Properties view of an object, laid out in cards from what its driver describes: its
 * general information, the details of the object, its storage and structure, and the rest.
 * Drivers name their properties in their queries; the names known here go to their card,
 * the others to «More properties», so a new driver needs nothing from the interface.
 */
import { cellText, isNull } from './results';

/** How a property's value is drawn: plain, as code, as a tag, as a date or as a number. */
export type PropertyStyle = 'text' | 'code' | 'tag' | 'date' | 'number';

export interface PropertyRow {
  /** The name it is shown under, a message key. */
  name: string;
  value: string;
  style: PropertyStyle;
  /** Offered to copy, such as the qualified name or the object's id. */
  copy?: boolean;
  /** An explanation shown beside the name, a message key. */
  hint?: string;
}

export interface PropertyCards {
  general: PropertyRow[];
  details: PropertyRow[];
  storage: PropertyRow[];
  more: PropertyRow[];
  definition?: string;
}

interface Described {
  name: string;
  properties: readonly { name: string; value: unknown }[];
  sections: readonly { id: string; rows: readonly unknown[] }[];
}

/** The properties each card takes, in its order, and how each one is drawn. */
const DETAILS: Record<string, { style: PropertyStyle; copy?: boolean }> = {
  'Object ID': { style: 'code', copy: true },
  Created: { style: 'date' },
  Modified: { style: 'date' },
  'Last vacuum': { style: 'date' },
  'Last analyze': { style: 'date' },
  Persistence: { style: 'tag' },
};
const STORAGE = ['Estimated rows', 'Table size', 'Size'];
/** The sections whose rows are counted in «Storage / Structure». */
const COUNTED: [string, string][] = [
  ['columns', 'Columns'],
  ['indexes', 'Indexes'],
  ['constraints', 'Constraints'],
  ['foreign-keys', 'Foreign keys'],
  ['references', 'Referenced by'],
  ['triggers', 'Triggers'],
];
const GENERAL = new Set(['Kind', 'Owner', 'Comment', 'Definition']);

/** The schema an object of the tree is in: the segment after `schemas` in its path. */
export function schemaOf(path: readonly string[]): string | undefined {
  const at = path.indexOf('schemas');
  return at >= 0 && path.length > at + 2 ? path[at + 1] : undefined;
}

/**
 * The cards of an object's properties. `format` writes dates and numbers as the interface's
 * language does.
 */
export function propertyCards(
  object: Described,
  path: readonly string[],
  format: { date(text: string): string; number(value: number): string },
): PropertyCards {
  const found = new Map(
    object.properties
      .filter((property) => !isNull(property.value) && cellText(property.value) !== '')
      .map((property) => [property.name, cellText(property.value)]),
  );
  const schema = schemaOf(path);
  const general: PropertyRow[] = [
    { name: 'Qualified name', value: object.name, style: 'code', copy: true },
    ...(schema ? [{ name: 'Schema', value: schema, style: 'code' as const }] : []),
    ...(found.has('Kind')
      ? [{ name: 'Kind', value: found.get('Kind')!, style: 'tag' as const }]
      : []),
    ...(found.has('Owner')
      ? [{ name: 'Owner', value: found.get('Owner')!, style: 'tag' as const }]
      : []),
    { name: 'Description', value: found.get('Comment') ?? '—', style: 'text' },
  ];
  const details = Object.entries(DETAILS).flatMap(([name, { style, copy }]) => {
    const value = found.get(name);
    if (value === undefined) return [];
    return [{ name, value: style === 'date' ? format.date(value) : value, style, copy }];
  });
  const number = (text: string) =>
    Number.isFinite(Number(text)) ? format.number(Number(text)) : text;
  const storage: PropertyRow[] = [
    ...STORAGE.flatMap((name) => {
      const value = found.get(name);
      if (value === undefined) return [];
      const shown = name === 'Estimated rows' ? number(value) : value;
      return name === 'Size'
        ? [{ name: 'Total size', value: shown, style: 'number' as const, hint: 'db.props.total' }]
        : [{ name, value: shown, style: 'number' as const }];
    }),
    ...COUNTED.flatMap(([id, name]) => {
      const section = object.sections.find((candidate) => candidate.id === id);
      return section
        ? [{ name, value: format.number(section.rows.length), style: 'number' as const }]
        : [];
    }),
  ];
  const taken = new Set([...GENERAL, ...Object.keys(DETAILS), ...STORAGE]);
  const more = [...found]
    .filter(([name]) => !taken.has(name))
    .map(([name, value]) => ({ name, value, style: 'text' as const }));
  const definition = found.get('Definition');
  return { general, details, storage, more, ...(definition ? { definition } : {}) };
}

/** How many rows a section of the object has, when the driver describes it. */
export function sectionCount(object: Described, id: string): number | undefined {
  return object.sections.find((section) => section.id === id)?.rows.length;
}
