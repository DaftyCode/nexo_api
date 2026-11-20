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
  // The host's JSON Schema validator (scripts/schema.rs), reachable from here only.
  const checkSchema = globalThis.__nexoSchema;
  delete globalThis.__nexoSchema;
  /** Where `value` does not match `schema`: the host checks all but `pattern`, left to RegExp. */
  function schemaProblems(value, schema) {
    const result = JSON.parse(checkSchema(stringify(schema) ?? 'true', stringify(value) ?? 'null'));
    for (const { path, pattern, value: text } of result.patterns) {
      let matched = false;
      try {
        matched = new RegExp(pattern, 'u').test(text);
      } catch {
        result.problems.push({ path, message: `Invalid pattern ${pattern}` });
        continue;
      }
      if (!matched)
        result.problems.push({ path, message: `Expected ${stringify(text)} to match ${pattern}` });
    }
    return result.problems;
  }
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
