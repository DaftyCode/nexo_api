import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  BindingPipe,
  Conditional,
  LiteralPrimitive,
  ParenthesizedExpression,
  parseTemplate,
} from '@angular/compiler';
import ts from 'typescript';
import { untranslatedTexts } from './i18n-untranslated.mjs';
const path = 'src/app/infrastructure/i18n/';
const en = JSON.parse(await readFile(`${path}en.json`, 'utf8'));
const es = JSON.parse(await readFile(`${path}es.json`, 'utf8'));
assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort(), 'Locale message keys must match');
for (const key of Object.keys(en)) {
  assert.ok(typeof en[key] === 'string' && en[key].trim(), `Empty English message: ${key}`);
  assert.ok(typeof es[key] === 'string' && es[key].trim(), `Empty Spanish message: ${key}`);
  const parameters = (value) =>
    [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    parameters(en[key]),
    parameters(es[key]),
    `Translation parameters differ: ${key}`,
  );
}
function verifyKey(expression) {
  if (expression instanceof LiteralPrimitive && typeof expression.value === 'string') {
    assert.ok(
      Object.hasOwn(en, expression.value),
      `Message used by a template is missing: ${expression.value}`,
    );
  } else if (expression instanceof ParenthesizedExpression) {
    verifyKey(expression.expression);
  } else if (expression instanceof Conditional) {
    verifyKey(expression.trueExp);
    verifyKey(expression.falseExp);
  } else if (expression?.operation === '||') {
    verifyKey(expression.left);
    verifyKey(expression.right);
  }
}
function checkTemplate(source, file) {
  const result = parseTemplate(source, file);
  assert.ok(!result.errors?.length, `Invalid Angular template: ${file}`);
  const visited = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value instanceof BindingPipe && value.name === 'transloco') verifyKey(value.exp);
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          'sourceSpan',
          'span',
          'startSourceSpan',
          'endSourceSpan',
          'nameSpan',
          'keySpan',
          'valueSpan',
        ].includes(key)
      )
        continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  result.nodes.forEach(visit);
  for (const text of untranslatedTexts(result.nodes)) shown.push({ file, text });
}
/** Text a template shows without transloco, with the file that shows it. */
const shown = [];
const presentation = await readdir('src/app/presentation', { recursive: true });
for (const name of presentation.map((each) => each.replaceAll('\\', '/'))) {
  const file = `src/app/presentation/${name}`;
  if (name.endsWith('.html')) checkTemplate(await readFile(file, 'utf8'), file);
  else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
    const ast = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'template' &&
        ts.isNoSubstitutionTemplateLiteral(node.initializer)
      )
        checkTemplate(node.initializer.text, file);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
// Every text on screen is in every language. What reads the same in all of them (a protocol,
// a format, code, an example) is listed once, on purpose, in i18n-same-text.json.
const same = new Set(JSON.parse(await readFile('tools/i18n-same-text.json', 'utf8')).texts);
const untranslated = shown.filter(({ text }) => !same.has(text));
assert.deepEqual(
  untranslated.map(({ file, text }) => `${file}: "${text}"`),
  [],
  'Text shown without translation. Put it through transloco with its entry in en.json and es.json; if it reads the same in every language (a protocol, a format, code, an example), add it to tools/i18n-same-text.json.',
);
const stale = [...same].filter((text) => !shown.some((each) => each.text === text));
assert.deepEqual(stale, [], 'tools/i18n-same-text.json lists texts no template shows any more');
console.log(
  `English and Spanish: ${Object.keys(en).length} complete messages; interpolation parameters match; ${same.size} texts read the same in every language.`,
);
