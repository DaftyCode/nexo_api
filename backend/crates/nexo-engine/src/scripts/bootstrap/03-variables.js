  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
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
  // Vault secrets and OAuth 2.0 tokens never enter this context: the host fills their
  // references into the outgoing request after this replacement, so neither a script nor a
  // built-in it overrides can read them.
  const scriptScopes = ['local', 'data', 'environment', 'collection', 'globals'];
  const secretReference = (key) => key.startsWith('vault:') || key.startsWith('$oauth2.');
  function replace(value, scopes = scriptScopes, keepSecrets = false) {
    if (typeof value === 'string')
      return value.replace(/\{\{([^{}]+)\}\}/g, (match, raw) => {
        const key = raw.trim();
        // The host resolves these; a variable with the same name must not shadow them.
        if (keepSecrets && secretReference(key)) return match;
        if (key === '$guid' || key === '$randomUUID') return state.uuid;
        if (key === '$timestamp') return String(Math.floor(Date.now() / 1000));
        if (key === '$isoTimestamp') return new Date().toISOString();
        if (key === '$randomInt') return String(Math.floor(Math.random() * 1000));
        for (const name of scopes)
          if (Object.hasOwn(state[name], key)) return String(state[name][key]);
        return match;
      });
    if (Array.isArray(value)) return value.map((item) => replace(item, scopes, keepSecrets));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replace(item, scopes, keepSecrets)]),
      );
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
