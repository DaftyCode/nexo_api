import { ErdPalette, erdPalette } from '../../domain/db/erd-svg';

/** The palette of the theme in use, from the tokens as they apply to `element`. */
export function themePalette(element: Element): ErdPalette {
  const style = getComputedStyle(element);
  return erdPalette((name) => style.getPropertyValue(name));
}

/** An SVG as an image address, for the print preview and to draw it on a canvas. */
export const svgImage = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The most pixels a PNG gets: a large diagram is drawn smaller rather than not at all. */
const MAX_PIXELS = 40_000_000;

/** An SVG drawn as a PNG, twice as sharp as on screen when it fits. */
export async function pngOf(svg: string, width: number, height: number): Promise<Blob> {
  const scale = Math.max(0.25, Math.min(2, Math.sqrt(MAX_PIXELS / Math.max(1, width * height))));
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('db.diagram.png'));
  });
  image.src = svgImage(svg);
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('db.diagram.png');
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('db.diagram.png'))),
      'image/png',
    ),
  );
}
