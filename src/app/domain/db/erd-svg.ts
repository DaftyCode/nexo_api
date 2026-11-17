/**
 * A diagram as a standalone SVG file, to export it or print it (DB-20): the scene drawn with
 * the colors of the theme in use, which the interface reads from its tokens and passes here.
 */
import { ERD_COLORS, ErdColor } from './erd-document';
import { ERD_SIZES } from './erd-layout';
import { ErdScene, NOTE_SIZE } from './erd-scene';

/** The colors and fonts of the theme a diagram is drawn with. */
export interface ErdPalette {
  background: string;
  surface: string;
  header: string;
  text: string;
  muted: string;
  border: string;
  line: string;
  note: string;
  font: string;
  mono: string;
  colors: Record<ErdColor, string>;
}

/** The tokens each color of the palette comes from. */
export const PALETTE_TOKENS: Record<Exclude<keyof ErdPalette, 'colors'>, string> = {
  background: '--nexo-color-bg',
  surface: '--nexo-color-surface',
  header: '--nexo-color-surface-2',
  text: '--nexo-color-text',
  muted: '--nexo-color-text-muted',
  border: '--nexo-color-border-strong',
  line: '--nexo-color-text-soft',
  note: '--nexo-color-warning-soft',
  font: '--nexo-font-sans',
  mono: '--nexo-font-mono',
};
export const colorToken = (color: ErdColor) => `--nexo-color-${color}`;

/** The palette of a theme, from what each token is worth in it. */
export function erdPalette(token: (name: string) => string): ErdPalette {
  const entries = Object.entries(PALETTE_TOKENS).map(([key, name]) => [key, token(name).trim()]);
  return {
    ...(Object.fromEntries(entries) as Omit<ErdPalette, 'colors'>),
    colors: Object.fromEntries(
      ERD_COLORS.map((color) => [color, token(colorToken(color)).trim()]),
    ) as Record<ErdColor, string>,
  };
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attribute = (value: string) => `"${escape(value)}"`;

/** The SVG text of a scene. */
export function erdSvg(scene: ErdScene, palette: ErdPalette): string {
  const { x, y, width, height } = scene.bounds;
  const { header, padding } = ERD_SIZES;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" font-family=${attribute(palette.font)} font-size="12">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill=${attribute(palette.background)}/>`,
  ];
  for (const line of scene.lines) {
    parts.push(
      `<path d="${line.d}" fill="none" stroke=${attribute(palette.line)}${line.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
    for (const mark of line.marks)
      parts.push(
        `<path d="${mark.d}" fill=${attribute(mark.filled ? palette.line : palette.background)} stroke=${attribute(palette.line)}/>`,
      );
    for (const label of line.labels)
      parts.push(
        `<text x="${label.x}" y="${label.y}" fill=${attribute(palette.muted)} font-size="11">${escape(label.text)}</text>`,
      );
  }
  for (const entity of scene.entities) {
    const box = entity.box;
    const tint = entity.color ? palette.colors[entity.color] : palette.border;
    parts.push(
      `<g><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="4" fill=${attribute(palette.surface)} stroke=${attribute(tint)}/>`,
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${header}" rx="4" fill=${attribute(entity.color ? tint : palette.header)}/>`,
      `<text x="${box.x + padding}" y="${box.y + header / 2 + 4}" fill=${attribute(palette.text)} font-weight="600">${escape(entity.name)}</text>`,
    );
    for (const row of entity.rows) {
      const badge = row.primary ? 'PK' : row.foreign ? 'FK' : '';
      if (badge)
        parts.push(
          `<text x="${box.x + padding}" y="${box.y + row.y + 4}" fill=${attribute(palette.muted)} font-size="9">${badge}</text>`,
        );
      parts.push(
        `<text x="${box.x + padding + 18}" y="${box.y + row.y + 4}" fill=${attribute(palette.text)} font-family=${attribute(palette.mono)}${row.primary ? ' font-weight="600"' : ''}>${escape(row.text)}</text>`,
      );
    }
    parts.push('</g>');
  }
  for (const note of scene.notes) {
    const box = note.box;
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill=${attribute(palette.note)} stroke=${attribute(palette.border)}/>`,
      ...note.text
        .split('\n')
        .map(
          (text, at) =>
            `<text x="${box.x + NOTE_SIZE.padding}" y="${box.y + NOTE_SIZE.padding + (at + 1) * NOTE_SIZE.line - 4}" fill=${attribute(palette.text)}>${escape(text)}</text>`,
        ),
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}
