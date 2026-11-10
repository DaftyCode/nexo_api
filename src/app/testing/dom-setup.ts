/**
 * What jsdom lacks for CodeMirror to run in unit tests: text ranges measure as empty boxes,
 * since nothing is laid out.
 */
const empty = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect ??= function () {
    return empty() as DOMRect;
  };
}
