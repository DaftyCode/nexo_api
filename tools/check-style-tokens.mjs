// Fails when a style rule writes a raw colour or size instead of a design token (src/styles/README.md).
// Only the token files hold literal values: src/styles/tokens/ and each template's _theme.scss.
// Checked: every colour, and the font, spacing, corner, line, shadow, motion, opacity and
// stacking properties. Layout constraints (a dialog width, a list height) may stay in px.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_FILES = /^src\/styles\/tokens\/|\/_theme\.scss$/;

/** Literal colours: hex, rgb()/hsl() and named black/white. */
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/i;

/** Properties whose value must come from a token, and the literals they may still use. */
const SCALED = [
  [/^font$/, /^inherit$/],
  [/^font-size$/, /^(inherit|1em|100%)$/],
  [/^font-weight$/, /^(inherit)$/],
  [/^line-height$/, /^(inherit|normal)$/],
  [/^letter-spacing$/, /^(inherit|normal)$/],
  [/^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?$/, null],
  [/^border(-[a-z]+)*-radius$/, null],
  [/^(box-shadow|text-shadow)$/, /^(none|inherit)$/],
  [/^(border|outline)(-(top|right|bottom|left))?(-width)?$/, /^(0|none)$/],
  [/^outline-offset$/, /^0$/],
  [/^(transition|animation)(-duration)?$/, /^none( !important)?$/],
  [/^z-index$/, /^(auto|0|-1)$/],
  [/^opacity$/, /^(0|1)$/],
];
/** A raw length or number left in a scaled property: `12px`, `1.4`, `600`, `0.3s`. */
const RAW_SIZE = /(?<![\w-])-?\d*\.?\d+(px|em|rem|s|ms)?(?![\w%-])/;

async function files(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) results.push(...(await files(path)));
    else if (/\.scss$/.test(path) || (/\.ts$/.test(path) && !path.endsWith('.spec.ts')))
      results.push(path);
  }
  return results;
}

/** The CSS of a file: a stylesheet, or the `styles` of an Angular component. */
function css(path, text) {
  if (path.endsWith('.scss')) return text;
  return [...text.matchAll(/styles:\s*\[?\s*`([\s\S]*?)`/g)].map((match) => match[1]).join('\n');
}

const failures = [];
for (const path of await files('src')) {
  if (TOKEN_FILES.test(path)) continue;
  const text = await readFile(path, 'utf8');
  const styles = css(path, text);
  if (!styles) continue;
  // Declarations, joined across lines so multi-line values (shadows, transitions) are whole.
  const declarations = styles
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;{}]+);/g);
  for (const [, property, raw] of declarations) {
    if (property.startsWith('--')) continue;
    const value = raw.replace(/\s+/g, ' ').trim();
    if (COLOUR.test(value)) failures.push(`${path}: ${property}: ${value} (use a colour token)`);
    for (const [name, allowed] of SCALED) {
      if (!name.test(property) || allowed?.test(value)) continue;
      const withoutTokens = value.replace(/var\([^()]*\)/g, '').replace(/calc\(-1 \*\s*\)/g, '');
      if (RAW_SIZE.test(withoutTokens.replace(/\b0\b/g, '')))
        failures.push(`${path}: ${property}: ${value} (use a size token)`);
    }
  }
}
// The code editor theme is TypeScript, not a stylesheet: its colours are checked as strings.
const editor = 'src/app/presentation/code-editor-setup.ts';
for (const [line, index] of (await readFile(editor, 'utf8')).split('\n').map((l, i) => [l, i]))
  if (COLOUR.test(line))
    failures.push(`${editor}:${index + 1}: ${line.trim()} (use a colour token)`);

if (failures.length) {
  console.error(`Raw style values outside the design tokens:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else
  console.log('Style tokens verified: no raw colours or scaled sizes outside the theme files.');
