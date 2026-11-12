  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
  const test = (name, callback) => {
    const assertion = {
      name,
      passed: true,
      skipped: false,
      iteration: state.iteration,
      request: state.requestName,
    };
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
    state.assertions.push({
      name,
      passed: true,
      skipped: true,
      iteration: state.iteration,
      request: state.requestName,
    });
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
        for (const name of scriptScopes)
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
    // OAuth 2.0 tokens can be deleted (the next send gets a new one) but never read.
    oauth2: {
      reset: (name) => {
        state.oauth2Resets.push(String(name));
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
