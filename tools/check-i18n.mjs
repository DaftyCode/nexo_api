import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { BindingPipe, Conditional, LiteralPrimitive, parseTemplate } from '@angular/compiler';
import ts from 'typescript';
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
}
for (const name of await readdir('src/app/presentation')) {
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
console.log(
  `English and Spanish: ${Object.keys(en).length} complete messages; interpolation parameters match.`,
);
