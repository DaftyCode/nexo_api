/**
 * A diagram ready to draw (DB-20): each entity in its box, at the place it was moved to or
 * where the layout put it, with the rows it shows; each relation as a line in the notation
 * chosen; and the notes of the person. The canvas and the exported SVG draw the same scene.
 */
import { ErdModel, ErdNotation, shownColumns } from './erd';
import { DiagramNote, ErdColor } from './erd-document';
import { ERD_SIZES, ErdBox, ErdView, columnText, entitySize, erdBounds } from './erd-layout';
import { ErdLine, relationLine } from './erd-paths';

export interface SceneRow {
  name: string;
  text: string;
  primary: boolean;
  foreign: boolean;
  /** The middle of the row, from the top of its box. */
  y: number;
}
export interface SceneEntity {
  key: string;
  name: string;
  schema?: string;
  path: string[];
  box: ErdBox;
  rows: SceneRow[];
  color?: ErdColor;
}
export interface SceneLine extends ErdLine {
  key: string;
  name: string;
  from: string;
  to: string;
  fromColumns: string[];
  toColumns: string[];
}
export interface SceneNote extends DiagramNote {
  box: ErdBox;
}
export interface ErdScene {
  entities: SceneEntity[];
  lines: SceneLine[];
  notes: SceneNote[];
  bounds: ErdBox;
}

type Places = Readonly<Record<string, { x: number; y: number }>>;

export const NOTE_SIZE = { width: 200, line: 16, padding: 8 };

/** The box of a note: as tall as its lines. */
export function noteBox(note: DiagramNote): ErdBox {
  const lines = Math.max(1, note.text.split('\n').length);
  return {
    x: note.x,
    y: note.y,
    width: NOTE_SIZE.width,
    height: lines * NOTE_SIZE.line + NOTE_SIZE.padding * 2,
  };
}

/** The scene of a model, its entities at the places kept, else where the layout put them. */
export function erdScene(input: {
  model: ErdModel;
  view: ErdView;
  notation: ErdNotation;
  auto: Places;
  positions: Places;
  colors?: Readonly<Record<string, ErdColor>>;
  notes?: readonly DiagramNote[];
}): ErdScene {
  const { model, view } = input;
  const { header, row, padding } = ERD_SIZES;
  const boxes = new Map<string, ErdBox>();
  const entities = model.entities.map((entity): SceneEntity => {
    const at = input.positions[entity.key] ?? input.auto[entity.key] ?? { x: 0, y: 0 };
    const box = { x: at.x, y: at.y, ...entitySize(entity, view) };
    boxes.set(entity.key, box);
    const color = input.colors?.[entity.key];
    return {
      key: entity.key,
      name: entity.name,
      ...(entity.schema ? { schema: entity.schema } : {}),
      path: entity.path,
      box,
      rows: shownColumns(entity, view.detail).map((column, index) => ({
        name: column.name,
        text: columnText(column, view),
        primary: column.primary,
        foreign: column.foreign,
        y: header + padding / 2 + index * row + row / 2,
      })),
      ...(color ? { color } : {}),
    };
  });
  const known = new Map(model.entities.map((entity) => [entity.key, entity]));
  const lines = model.relations.map((relation): SceneLine => ({
    key: relation.key,
    name: relation.name,
    from: relation.from,
    to: relation.to,
    fromColumns: relation.fromColumns,
    toColumns: relation.toColumns,
    ...relationLine(
      relation,
      { from: known.get(relation.from)!, to: known.get(relation.to)! },
      { from: boxes.get(relation.from)!, to: boxes.get(relation.to)! },
      view,
      input.notation,
    ),
  }));
  const notes = (input.notes ?? []).map((note) => ({ ...note, box: noteBox(note) }));
  return {
    entities,
    lines,
    notes,
    bounds: erdBounds([...entities.map((entity) => entity.box), ...notes.map((note) => note.box)]),
  };
}
