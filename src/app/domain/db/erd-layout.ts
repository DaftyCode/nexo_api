/**
 * Where each entity of a diagram goes, with no library: by layers, the referenced tables on
 * the left and those that reference them to their right, ordered to cross few relations (the
 * barycenter of their neighbours, a few sweeps); or in a grid by name. The same model gives
 * the same places, and no two entities overlap.
 */
import { ErdDetail, ErdEntity, ErdModel, shownColumns } from './erd';

export interface ErdBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ErdView {
  detail: ErdDetail;
  /** The type and nullability of each column. */
  types: boolean;
}
export type ErdLayoutKind = 'layers' | 'grid';

export const ERD_SIZES = { header: 28, row: 18, padding: 8, char: 7, min: 120, max: 340 };
const GAP_X = 90;
const GAP_Y = 36;
const SWEEPS = 6;

/** The text of a column as an entity draws it. */
export function columnText(column: ErdEntity['columns'][number], view: ErdView): string {
  if (!view.types) return column.name;
  return `${column.name}  ${column.type}${column.nullable ? '' : ' NOT NULL'}`;
}

/** The size of an entity as it is drawn. */
export function entitySize(entity: ErdEntity, view: ErdView): { width: number; height: number } {
  const rows = shownColumns(entity, view.detail);
  const longest = Math.max(
    entity.name.length + 2,
    ...rows.map((column) => columnText(column, view).length + 3),
  );
  const { header, row, padding, char, min, max } = ERD_SIZES;
  return {
    width: Math.min(max, Math.max(min, Math.round(longest * char + padding * 3))),
    height: header + rows.length * row + (rows.length ? padding : 0),
  };
}

const byKey = (a: ErdEntity, b: ErdEntity) => a.key.localeCompare(b.key);

/** The layer of each entity: one more than the deepest table it references (cycles broken). */
function layers(entities: readonly ErdEntity[], parents: Map<string, string[]>) {
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = layer.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    const deepest = Math.max(-1, ...(parents.get(key) ?? []).map(visit));
    visiting.delete(key);
    layer.set(key, deepest + 1);
    return deepest + 1;
  };
  for (const entity of entities) visit(entity.key);
  return layer;
}

/** The entities in layers, ordered within each to cross few relations. */
function ordered(entities: ErdEntity[], model: ErdModel): ErdEntity[][] {
  const parents = new Map<string, string[]>();
  const neighbours = new Map<string, string[]>();
  for (const relation of model.relations) {
    if (relation.from === relation.to) continue;
    parents.set(relation.from, [...(parents.get(relation.from) ?? []), relation.to]);
    neighbours.set(relation.from, [...(neighbours.get(relation.from) ?? []), relation.to]);
    neighbours.set(relation.to, [...(neighbours.get(relation.to) ?? []), relation.from]);
  }
  const layer = layers(entities, parents);
  const columns: ErdEntity[][] = [];
  for (const entity of entities) (columns[layer.get(entity.key)!] ??= []).push(entity);
  const position = new Map<string, number>();
  const place = () =>
    columns.forEach((column) => column.forEach((entity, at) => position.set(entity.key, at)));
  place();
  const center = (entity: ErdEntity, near: number) => {
    const around = (neighbours.get(entity.key) ?? []).filter((key) => layer.get(key) === near);
    if (!around.length) return position.get(entity.key)!;
    return around.reduce((sum, key) => sum + position.get(key)!, 0) / around.length;
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    const order = columns.map((_, at) => at);
    if (!forward) order.reverse();
    for (const at of order.slice(1)) {
      const near = forward ? at - 1 : at + 1;
      columns[at] = [...(columns[at] ?? [])].sort(
        (a, b) => center(a, near) - center(b, near) || byKey(a, b),
      );
      place();
    }
  }
  return columns.filter(Boolean);
}

/** Entities in rows, by name, under `top`, the rows as wide as `width`. */
function gridOf(
  entities: readonly ErdEntity[],
  sizes: Map<string, { width: number; height: number }>,
  top: number,
  width: number,
) {
  const boxes: Record<string, ErdBox> = {};
  let x = 0;
  let y = top;
  let tallest = 0;
  for (const entity of entities) {
    const size = sizes.get(entity.key)!;
    if (x > 0 && x + size.width > width) {
      x = 0;
      y += tallest + GAP_Y;
      tallest = 0;
    }
    boxes[entity.key] = { x, y, ...size };
    x += size.width + GAP_X / 2;
    tallest = Math.max(tallest, size.height);
  }
  return boxes;
}

/** Where every entity of the model goes. */
export function erdLayout(model: ErdModel, view: ErdView, kind: ErdLayoutKind = 'layers') {
  const entities = [...model.entities].sort(byKey);
  const sizes = new Map(entities.map((entity) => [entity.key, entitySize(entity, view)]));
  if (kind === 'grid') {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(entities.length * 1.6)));
    const width = perRow * (ERD_SIZES.max * 0.6 + GAP_X / 2);
    return gridOf(entities, sizes, 0, width);
  }
  const related = new Set(
    model.relations
      .filter((relation) => relation.from !== relation.to)
      .flatMap((relation) => [relation.from, relation.to]),
  );
  const linked = entities.filter((entity) => related.has(entity.key));
  const alone = entities.filter((entity) => !related.has(entity.key));
  const boxes: Record<string, ErdBox> = {};
  let x = 0;
  let bottom = 0;
  for (const column of ordered(linked, model)) {
    let y = 0;
    const width = Math.max(...column.map((entity) => sizes.get(entity.key)!.width));
    for (const entity of column) {
      const size = sizes.get(entity.key)!;
      boxes[entity.key] = { x, y, ...size };
      y += size.height + GAP_Y;
    }
    bottom = Math.max(bottom, y);
    x += width + GAP_X;
  }
  // Tables that relate to none go below, in a grid as wide as the layers.
  const top = linked.length ? bottom + GAP_Y : 0;
  return { ...boxes, ...gridOf(alone, sizes, top, Math.max(x, 4 * (ERD_SIZES.min + GAP_X))) };
}

/** The rectangle that holds every box, with a margin. */
export function erdBounds(boxes: readonly ErdBox[], margin = 24): ErdBox {
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((box) => box.x)) - margin;
  const top = Math.min(...boxes.map((box) => box.y)) - margin;
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + margin;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + margin;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
