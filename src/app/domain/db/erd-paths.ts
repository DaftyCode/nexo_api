/**
 * How a relation is drawn between two entities: an elbowed line from the column that holds the
 * key to the column it references, and its ends in the notation chosen — IDEF1X (a dot on the
 * many side, a diamond where the key may be `NULL`, dashed when it does not identify), crow's
 * foot (the crow's foot, bars and circles) or UML (multiplicities as text).
 */
import { ErdEntity, ErdNotation, ErdRelation, shownColumns } from './erd';
import { ERD_SIZES, ErdBox, ErdView } from './erd-layout';

export interface ErdMark {
  d: string;
  filled: boolean;
}
export interface ErdLabel {
  x: number;
  y: number;
  text: string;
}
export interface ErdLine {
  d: string;
  dashed: boolean;
  marks: ErdMark[];
  labels: ErdLabel[];
}

const OUT = 18;

/** Where a column's row is, or the header when the column is not shown. */
function rowY(entity: ErdEntity, box: ErdBox, column: string | undefined, view: ErdView) {
  const rows = shownColumns(entity, view.detail);
  const at = column === undefined ? -1 : rows.findIndex((each) => each.name === column);
  const { header, row, padding } = ERD_SIZES;
  return at < 0 ? box.y + header / 2 : box.y + header + padding / 2 + at * row + row / 2;
}

/** The ends of a relation: a side of each box, facing each other, or both on the right. */
function sides(from: ErdBox, to: ErdBox) {
  const apart = from.x > to.x + to.width || to.x > from.x + from.width;
  if (!apart) return { fromX: from.x + from.width, fromDir: 1, toX: to.x + to.width, toDir: 1 };
  return from.x > to.x
    ? { fromX: from.x, fromDir: -1, toX: to.x + to.width, toDir: 1 }
    : { fromX: from.x + from.width, fromDir: 1, toX: to.x, toDir: -1 };
}

const bar = (x: number, y: number) => `M ${x} ${y - 6} L ${x} ${y + 6}`;
const circle = (x: number, y: number, r: number) =>
  `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;

/** The marks of one end, at the edge `x`, the line leaving it towards `dir`. */
function ends(
  notation: ErdNotation,
  x: number,
  y: number,
  dir: number,
  end: { many: boolean; optional: boolean; parent: boolean },
): { marks: ErdMark[]; labels: ErdLabel[] } {
  if (notation === 'uml') {
    const text = end.many ? '*' : end.optional ? '0..1' : '1';
    return { marks: [], labels: [{ x: x + dir * 10, y: y - 6, text }] };
  }
  if (notation === 'idef1x') {
    if (!end.parent && end.many)
      return { marks: [{ d: circle(x + dir * 4, y, 3.5), filled: true }], labels: [] };
    if (end.parent && end.optional)
      return {
        marks: [
          {
            d: `M ${x} ${y} L ${x + dir * 6} ${y - 5} L ${x + dir * 12} ${y} L ${x + dir * 6} ${y + 5} Z`,
            filled: false,
          },
        ],
        labels: [],
      };
    return { marks: [], labels: [] };
  }
  const marks: ErdMark[] = [];
  if (end.many)
    marks.push({
      d: `M ${x + dir * 12} ${y} L ${x} ${y - 6} M ${x + dir * 12} ${y} L ${x} ${y} M ${x + dir * 12} ${y} L ${x} ${y + 6}`,
      filled: false,
    });
  else marks.push({ d: bar(x + dir * 8, y), filled: false });
  marks.push(
    end.optional
      ? { d: circle(x + dir * 15, y, 3), filled: false }
      : { d: bar(x + dir * 15, y), filled: false },
  );
  return { marks, labels: [] };
}

/** The line of a relation between the boxes of its entities. */
export function relationLine(
  relation: ErdRelation,
  entities: { from: ErdEntity; to: ErdEntity },
  boxes: { from: ErdBox; to: ErdBox },
  view: ErdView,
  notation: ErdNotation,
): ErdLine {
  const y1 = rowY(entities.from, boxes.from, relation.fromColumns[0], view);
  const y2 = rowY(entities.to, boxes.to, relation.toColumns[0], view);
  let d: string;
  const side = sides(boxes.from, boxes.to);
  if (entities.from === entities.to) {
    // A table that references itself: a loop on its right.
    const x = boxes.from.x + boxes.from.width;
    d = `M ${x} ${y1} H ${x + OUT * 2} V ${y2 + 10} H ${x}`;
  } else if (side.fromDir === side.toDir) {
    const x = Math.max(side.fromX, side.toX) + OUT * 2;
    d = `M ${side.fromX} ${y1} H ${x} V ${y2} H ${side.toX}`;
  } else {
    const middle = (side.fromX + side.toX) / 2;
    d = `M ${side.fromX} ${y1} H ${middle} V ${y2} H ${side.toX}`;
  }
  const child = ends(notation, side.fromX, y1, side.fromDir, {
    many: relation.many,
    optional: false,
    parent: false,
  });
  const parent = ends(
    notation,
    side.toX,
    entities.from === entities.to ? y2 + 10 : y2,
    side.toDir,
    {
      many: false,
      optional: relation.optional,
      parent: true,
    },
  );
  return {
    d,
    dashed: notation === 'idef1x' && !relation.identifying,
    marks: [...child.marks, ...parent.marks],
    labels: [...child.labels, ...parent.labels],
  };
}
