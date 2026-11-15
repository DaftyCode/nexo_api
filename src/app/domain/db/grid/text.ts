/** The plain text view of a grid: the rows shown as an aligned table of text, to copy. */
import { ResultColumn } from '../results';
import { GridFormats, formatCell } from './cells';

/** The widest a column of the text view gets, in characters. */
const WIDEST = 60;
/** The rows the text view shows, at most. */
export const TEXT_ROWS = 2000;

export function plainText(
  columns: readonly ResultColumn[],
  rows: readonly unknown[][],
  order: readonly number[],
  shown: readonly number[],
  formats: GridFormats,
): string {
  const texts = [
    order.map((column) => columns[column].name),
    ...shown
      .slice(0, TEXT_ROWS)
      .map((index) => order.map((column) => formatCell(rows[index][column], formats).text)),
  ];
  const widths = order.map((_, k) =>
    Math.min(WIDEST, Math.max(...texts.map((line) => line[k].length))),
  );
  const line = (cells: readonly string[]) =>
    cells.map((text, k) => text.slice(0, WIDEST).padEnd(widths[k])).join(' | ');
  return [
    line(texts[0]),
    widths.map((width) => '-'.repeat(width)).join('-+-'),
    ...texts.slice(1).map(line),
  ].join('\n');
}
