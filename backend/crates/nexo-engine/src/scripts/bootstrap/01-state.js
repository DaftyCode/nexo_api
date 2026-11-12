// Script API (pm.* / nx.*) evaluated inside an isolated QuickJS context.
// The host only exchanges JSON strings with it through __nexo. Its parts are the files of
// this folder, joined in order; the last one ends without a semicolon: the engine appends
// `(seed)` to call this function.
(function bootstrap(seed) {
  const state = {
    ...seed,
    assertions: [],
    logs: [],
    queue: [],
    callbacks: {},
    skip: false,
    oauth2Resets: [],
  };
  const stringify = JSON.stringify;
  const serialize = (value) => (typeof value === 'string' ? value : stringify(value));
  function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
