// Finds the text a template shows that does not go through transloco: text between tags, the
// fixed text around an interpolation, and the title, placeholder, aria-label, alt and label
// attributes written as plain values. Code shown as code (<code>, <pre>, <kbd>) is skipped.
import {
  TmplAstBoundText,
  TmplAstElement,
  TmplAstText,
  TmplAstTextAttribute,
} from '@angular/compiler';

const ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);
const CODE = new Set(['code', 'pre', 'kbd', 'script', 'style']);
const SPANS = new Set([
  'sourceSpan',
  'span',
  'startSourceSpan',
  'endSourceSpan',
  'nameSpan',
  'keySpan',
  'valueSpan',
]);
const words = (text) => text.replace(/\s+/g, ' ').trim();
const readable = (text) => /[A-Za-z]{2,}/.test(text);

/** The untranslated texts of a parsed template, in the order they appear. */
export function untranslatedTexts(nodes) {
  const found = [];
  const visited = new WeakSet();
  function visit(value, code) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value instanceof TmplAstText) {
      if (!code && readable(value.value)) found.push(words(value.value));
      return;
    }
    if (value instanceof TmplAstBoundText) {
      const fixed = words((value.value?.ast?.strings ?? []).join(' '));
      if (!code && readable(fixed)) found.push(fixed);
      return;
    }
    if (value instanceof TmplAstTextAttribute) {
      if (ATTRIBUTES.has(value.name) && readable(value.value)) found.push(words(value.value));
      return;
    }
    const inside = code || (value instanceof TmplAstElement && CODE.has(value.name));
    for (const [key, child] of Object.entries(value)) {
      if (SPANS.has(key)) continue;
      if (Array.isArray(child)) child.forEach((each) => visit(each, inside));
      else visit(child, inside);
    }
  }
  nodes.forEach((node) => visit(node, false));
  return found;
}
