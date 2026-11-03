import vm from 'node:vm';
import { requestUrl } from './transport.mjs';

// The context receives JSON values only. Host functions, modules and process objects
// never enter the script realm. Each evaluation also has a CPU timeout.
function bootstrap(seed) {
  const state = { ...seed, assertions: [], logs: [], queue: [], callbacks: {}, skip: false };
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
  function expect(value, message, negate = false, deep = false) {
    const check = (condition, description) => {
      if (Boolean(condition) === negate) throw new Error(message ?? description);
      return chain;
    };
    const methods = {
      equal: (other) =>
        check(
          deep ? equal(value, other) : Object.is(value, other),
          `Expected ${serialize(value)} to equal ${serialize(other)}`,
        ),
      eql: (other) =>
        check(
          equal(value, other),
          `Expected ${serialize(value)} to deeply equal ${serialize(other)}`,
        ),
      include: (other) =>
        check(
          typeof value === 'string' || Array.isArray(value)
            ? value.includes(other)
            : value && Object.entries(other).every(([key, item]) => equal(value[key], item)),
          'Expected value to include supplied value',
        ),
      property: (key, ...rest) => {
        check(
          value != null && key in Object(value) && (!rest.length || equal(value[key], rest[0])),
          `Expected property ${key}`,
        );
        return expect(value?.[key], message);
      },
      lengthOf: (size) => check(value?.length === size, `Expected length ${size}`),
      match: (pattern) => check(pattern.test(String(value)), 'Expected value to match pattern'),
      above: (other) => check(value > other, `Expected value above ${other}`),
      below: (other) => check(value < other, `Expected value below ${other}`),
      least: (other) => check(value >= other, `Expected value at least ${other}`),
      most: (other) => check(value <= other, `Expected value at most ${other}`),
      within: (min, max) =>
        check(value >= min && value <= max, `Expected value within ${min}..${max}`),
      oneOf: (list) => check(list.includes(value), 'Expected one of the supplied values'),
      keys: (...keys) =>
        check(equal(Object.keys(value).sort(), keys.flat().sort()), 'Expected object keys'),
      members: (items) =>
        check(
          Array.isArray(value) &&
            items.length === value.length &&
            items.every((item) => value.some((candidate) => equal(item, candidate))),
          'Expected array members',
        ),
      a: (type) =>
        check(
          type === 'array'
            ? Array.isArray(value)
            : type === 'null'
              ? value === null
              : typeof value === type,
          `Expected type ${type}`,
        ),
      throw: () => {
        let thrown = false;
        try {
          value();
        } catch {
          thrown = true;
        }
        return check(thrown, 'Expected function to throw');
      },
    };
    const chain = new Proxy(
      {},
      {
        get(_, key) {
          if (key === 'then') return undefined;
          if (
            [
              'to',
              'be',
              'have',
              'and',
              'that',
              'which',
              'is',
              'been',
              'with',
              'at',
              'of',
              'same',
            ].includes(key)
          )
            return chain;
          if (key === 'not') return expect(value, message, !negate, deep);
          if (key === 'deep') return expect(value, message, negate, true);
          if (key === 'an') return methods.a;
          if (key === 'equals') return methods.equal;
          if (key === 'contain' || key === 'contains') return methods.include;
          if (key === 'length') return methods.lengthOf;
          if (key === 'ok') return check(Boolean(value), 'Expected truthy value');
          if (key === 'true') return check(value === true, 'Expected true');
          if (key === 'false') return check(value === false, 'Expected false');
          if (key === 'null') return check(value === null, 'Expected null');
          if (key === 'undefined') return check(value === undefined, 'Expected undefined');
          if (key === 'exist') return check(value != null, 'Expected an existing value');
          if (key === 'empty')
            return check(
              value != null && (value.length === 0 || Object.keys(value).length === 0),
              'Expected empty value',
            );
          if (key in methods) return methods[key];
          throw new Error(`Unsupported assertion: ${String(key)}`);
        },
      },
    );
    return chain;
  }
  function scope(name, readOnly = false) {
    return {
      get: (key) => state[name][key],
      has: (key) => Object.hasOwn(state[name], key),
      set: (key, value) => {
        if (readOnly) throw new Error('Read-only variable scope');
        state[name][key] = value;
      },
      unset: (key) => {
        if (!readOnly) delete state[name][key];
      },
      clear: () => {
        if (!readOnly) state[name] = {};
      },
      toObject: () => ({ ...state[name] }),
      replaceIn: (text) => replace(text),
    };
  }
  function replace(value) {
    if (typeof value === 'string')
      return value.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
        if (key === '$guid' || key === '$randomUUID') return state.uuid;
        if (key === '$timestamp') return String(Math.floor(Date.now() / 1000));
        if (key === '$randomInt') return String(Math.floor(Math.random() * 1000));
        for (const name of ['secrets', 'local', 'data', 'environment', 'collection', 'globals'])
          if (Object.hasOwn(state[name], key)) return String(state[name][key]);
        return match;
      });
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  }
  function headerList(rows = []) {
    return {
      get: (key) => rows.find((row) => row.key.toLowerCase() === key.toLowerCase())?.value,
      has: (key) => rows.some((row) => row.key.toLowerCase() === key.toLowerCase()),
      all: () => rows,
      toObject: () => Object.fromEntries(rows.map(({ key, value }) => [key, value])),
      add: (row) => rows.push(row),
      upsert: (row) => {
        const index = rows.findIndex((item) => item.key.toLowerCase() === row.key.toLowerCase());
        if (index >= 0) rows[index] = row;
        else rows.push(row);
      },
      remove: (key) => {
        const index = rows.findIndex((row) => row.key.toLowerCase() === key.toLowerCase());
        if (index >= 0) rows.splice(index, 1);
      },
    };
  }
  function responseApi(value) {
    if (!value) return undefined;
    const response = {
      code: value.status,
      status: value.statusText,
      responseTime: value.time,
      responseSize: value.size,
      headers: headerList(value.headers),
      text: () => value.body,
      json: () => JSON.parse(value.body),
      cookies: {
        toObject: () =>
          Object.fromEntries((value.cookies ?? []).map((cookie) => [cookie.key, cookie.value])),
      },
    };
    response.to = {
      have: {
        status: (status) => expect(value.status).equal(status),
        header: (key, expected) => {
          expect(response.headers.has(key)).equal(true);
          if (expected !== undefined) expect(response.headers.get(key)).equal(expected);
        },
        body: (body) => expect(value.body).equal(body),
        jsonBody: (key, expected) =>
          key === undefined ? response.json() : expect(response.json()[key]).eql(expected),
      },
      be: {
        json: () => response.json(),
        successful: () => expect(value.status).within(200, 299),
        error: () => expect(value.status).within(400, 599),
      },
    };
    return response;
  }
  const test = (name, callback) => {
    const assertion = { name, passed: true, skipped: false, iteration: state.iteration };
    state.assertions.push(assertion);
    try {
      const result = callback();
      if (result?.then)
        result.catch((error) => {
          assertion.passed = false;
          assertion.error = error.message;
        });
    } catch (error) {
      assertion.passed = false;
      assertion.error = error.message;
    }
  };
  test.skip = (name) =>
    state.assertions.push({ name, passed: true, skipped: true, iteration: state.iteration });
  state.request.header ??= [];
  if (!Array.isArray(state.request.header))
    state.request.header = Object.entries(state.request.header).map(([key, value]) => ({
      key,
      value,
    }));
  const api = {
    environment: scope('environment'),
    globals: scope('globals'),
    collectionVariables: scope('collection'),
    iterationData: scope('data', true),
    variables: {
      ...scope('local'),
      get: (key) => {
        for (const name of ['secrets', 'local', 'data', 'environment', 'collection', 'globals'])
          if (Object.hasOwn(state[name], key)) return state[name][key];
      },
      replaceIn: replace,
    },
    info: {
      iteration: state.iteration,
      iterationCount: state.iterationCount,
      requestName: state.requestName,
      requestId: state.requestId,
    },
    request: { ...state.request, headers: headerList(state.request.header) },
    response: undefined,
    test,
    expect,
    execution: {
      setNextRequest: (name) => {
        state.next = name;
      },
      skipRequest: () => {
        state.skip = true;
      },
    },
    sendRequest: (request, callback) =>
      new Promise((resolve, reject) => {
        const id = String(Object.keys(state.callbacks).length);
        state.callbacks[id] = { callback, resolve, reject };
        state.queue.push({
          id,
          request: replace(typeof request === 'string' ? { url: request, method: 'GET' } : request),
        });
      }),
  };
  globalThis.nx = api;
  globalThis.pm = api;
  globalThis.console = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
      level,
      (...items) => {
        if (state.logs.length < 1000)
          state.logs.push({ level, values: items.map(serialize), iteration: state.iteration });
      },
    ]),
  );
  Object.defineProperty(globalThis, '__nexo', {
    value: Object.freeze({
      snapshot: () =>
        stringify({
          ...state,
          queue: undefined,
          callbacks: undefined,
          request: {
            ...state.request,
            method: api.request.method,
            url: api.request.url,
            body: api.request.body,
          },
        }),
      replace: (value) => stringify(replace(value)),
      queue: () => {
        const queue = state.queue;
        state.queue = [];
        return stringify(queue);
      },
      response: (value) => {
        api.response = responseApi(value);
      },
      deliver: (id, result, error) => {
        const entry = state.callbacks[id];
        const response = responseApi(result);
        if (entry.callback) {
          try {
            entry.callback(error ? new Error(error) : null, response);
            entry.resolve(response);
          } catch (error) {
            entry.reject(error);
          }
        } else if (error) entry.reject(new Error(error));
        else entry.resolve(response);
      },
    }),
  });
}
export class ScriptSession {
  #context;
  #send;
  constructor(seed, send) {
    this.#send = send;
    this.#context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    this.#evaluate(`(${bootstrap.toString()})(${JSON.stringify(seed)})`);
  }
  #evaluate(source) {
    return vm.runInContext(source, this.#context, { timeout: 5000, filename: 'nexo-script.js' });
  }
  snapshot() {
    return JSON.parse(this.#evaluate('__nexo.snapshot()'));
  }
  replace(value) {
    return JSON.parse(this.#evaluate(`__nexo.replace(${JSON.stringify(value)})`));
  }
  replaceUrl(value) {
    return requestUrl(this.replace(value));
  }
  async run(sources, response) {
    if (response) this.#evaluate(`__nexo.response(${JSON.stringify(response)})`);
    for (const source of sources)
      this.#evaluate(Array.isArray(source) ? source.join('\n') : String(source));
    for (let round = 0; ; round++) {
      const queue = JSON.parse(this.#evaluate('__nexo.queue()'));
      if (!queue.length) break;
      if (round >= 100) throw new Error('Script request limit exceeded');
      for (const { id, request } of queue) {
        let result, failure;
        try {
          result = await this.#send(request);
        } catch (error) {
          failure = error.message;
        }
        this.#evaluate(
          `__nexo.deliver(${JSON.stringify(id)},${JSON.stringify(result ?? null)},${JSON.stringify(failure ?? null)})`,
        );
      }
    }
  }
}
