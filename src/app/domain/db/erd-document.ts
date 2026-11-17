/**
 * A saved diagram (`db-diagram` document, with revisions): the tables of a connection put on
 * it, also of several schemas, where each one is drawn and its color, notes, and how it is
 * drawn. And the places of the automatic diagrams, kept in the workspace session.
 */
import { ERD_NOTATIONS, ErdDetail, ErdNotation } from './erd';

/** The colors an entity may take: names of the theme's color tokens. */
export const ERD_COLORS = ['accent', 'info', 'success', 'warning', 'danger'] as const;
export type ErdColor = (typeof ERD_COLORS)[number];

export interface DiagramTable {
  path: string[];
  name: string;
  schema?: string;
}
export interface DiagramEntity extends DiagramTable {
  x?: number;
  y?: number;
  color?: ErdColor;
  hidden?: boolean;
}
export interface DiagramNote {
  id: string;
  text: string;
  x: number;
  y: number;
}
export interface DiagramValue {
  connectionId: string;
  notation: ErdNotation;
  detail: ErdDetail;
  types: boolean;
  entities: DiagramEntity[];
  notes: DiagramNote[];
}

/** What an automatic diagram keeps in the session: where its entities were moved, and more. */
export interface DiagramLayout {
  positions: Record<string, { x: number; y: number }>;
  hidden?: string[];
  colors?: Record<string, ErdColor>;
  notation?: ErdNotation;
  detail?: ErdDetail;
  types?: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const texts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const color = (value: unknown) => ERD_COLORS.find((each) => each === value);

export function emptyDiagram(connectionId: string): DiagramValue {
  return { connectionId, notation: 'idef1x', detail: 'all', types: true, entities: [], notes: [] };
}

/** A stored diagram, read defensively: documents can come from Git or older versions. */
export function readDiagram(value: unknown): DiagramValue {
  const source = record(value);
  const base = emptyDiagram(
    typeof source['connectionId'] === 'string' ? source['connectionId'] : '',
  );
  const detail = source['detail'];
  const entities = (Array.isArray(source['entities']) ? source['entities'] : []).flatMap(
    (item): DiagramEntity[] => {
      const entity = record(item);
      const path = texts(entity['path']);
      if (typeof entity['name'] !== 'string' || !path.length) return [];
      const x = number(entity['x']);
      const y = number(entity['y']);
      const tint = color(entity['color']);
      return [
        {
          path,
          name: entity['name'],
          ...(typeof entity['schema'] === 'string' && entity['schema']
            ? { schema: entity['schema'] }
            : {}),
          ...(x !== undefined && y !== undefined ? { x, y } : {}),
          ...(tint ? { color: tint } : {}),
          ...(entity['hidden'] === true ? { hidden: true } : {}),
        },
      ];
    },
  );
  const notes = (Array.isArray(source['notes']) ? source['notes'] : []).flatMap(
    (item): DiagramNote[] => {
      const note = record(item);
      const x = number(note['x']);
      const y = number(note['y']);
      return typeof note['id'] === 'string' &&
        typeof note['text'] === 'string' &&
        x !== undefined &&
        y !== undefined
        ? [{ id: note['id'], text: note['text'], x, y }]
        : [];
    },
  );
  return {
    ...base,
    notation: ERD_NOTATIONS.find((each) => each === source['notation']) ?? base.notation,
    detail: detail === 'keys' || detail === 'none' ? detail : 'all',
    types: source['types'] !== false,
    entities,
    notes,
  };
}

/** The layouts of the automatic diagrams kept in a stored session, by diagram. */
export function readLayouts(value: unknown): Record<string, DiagramLayout> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => {
      const layout = record(item);
      const positions = Object.fromEntries(
        Object.entries(record(layout['positions'])).flatMap(([entity, at]) => {
          const x = number(record(at)['x']);
          const y = number(record(at)['y']);
          return x !== undefined && y !== undefined ? [[entity, { x, y }]] : [];
        }),
      );
      const colors = Object.fromEntries(
        Object.entries(record(layout['colors'])).flatMap(([entity, tint]) =>
          color(tint) ? [[entity, color(tint)!]] : [],
        ),
      );
      const notation = ERD_NOTATIONS.find((each) => each === layout['notation']);
      const detail = layout['detail'];
      return [
        key,
        {
          positions,
          ...(texts(layout['hidden']).length ? { hidden: texts(layout['hidden']) } : {}),
          ...(Object.keys(colors).length ? { colors } : {}),
          ...(notation ? { notation } : {}),
          ...(detail === 'all' || detail === 'keys' || detail === 'none' ? { detail } : {}),
          ...(typeof layout['types'] === 'boolean' ? { types: layout['types'] } : {}),
        },
      ];
    }),
  );
}

/** The table at a path of the tree; its schema is the segment after `schemas`, if any. */
export function diagramTable(path: readonly string[]): DiagramTable {
  const at = path.lastIndexOf('schemas');
  const schema = at >= 0 && path.length > at + 2 ? path[at + 1] : undefined;
  return { path: [...path], name: path.at(-1) ?? '', ...(schema ? { schema } : {}) };
}

/**
 * Another table beside one, by name and schema: in the same folder of tables, or in the same
 * folder of the other schema.
 */
export function siblingTable(table: DiagramTable, name: string, schema?: string): DiagramTable {
  const folder = table.path.slice(0, -1);
  const path =
    schema && table.schema && schema !== table.schema
      ? [...folder.slice(0, -2), schema, folder.at(-1)!, name]
      : [...folder, name];
  const owner = schema || table.schema;
  return { path, name, ...(owner ? { schema: owner } : {}) };
}

/** The key an automatic diagram is kept under: its connection and the path it shows. */
export const layoutKey = (connection: string, path: readonly string[]) =>
  `${connection}\n${path.join('\n')}`;
