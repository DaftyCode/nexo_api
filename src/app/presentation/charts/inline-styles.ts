/** What an SVG of its own needs of the styles of the page, written into each element. */
const PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'opacity',
  'font-size',
  'font-family',
  'text-anchor',
];

/**
 * An SVG of the page as a file: its elements get the colors, lines and fonts the theme gave
 * them, since its style sheets do not go with it.
 */
export function inlineStyles(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll('*')];
  const to = [copy, ...copy.querySelectorAll('*')];
  from.forEach((element, at) => {
    const style = getComputedStyle(element);
    const written = PROPERTIES.map((name) => [name, style.getPropertyValue(name)])
      .filter(([, value]) => value && value !== 'normal')
      .map(([name, value]) => `${name}:${value}`)
      .join(';');
    if (written) to[at].setAttribute('style', written);
  });
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute(
    'width',
    copy.viewBox.baseVal?.width ? String(copy.viewBox.baseVal.width) : '640',
  );
  copy.setAttribute(
    'height',
    copy.viewBox.baseVal?.height ? String(copy.viewBox.baseVal.height) : '300',
  );
  return new XMLSerializer().serializeToString(copy);
}
