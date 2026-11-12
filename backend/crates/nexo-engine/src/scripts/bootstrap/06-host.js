  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
  // Logs are bounded: 1000 entries of at most 16,384 characters each, so a script cannot fill
  // memory or the run state with them. Values that cannot be serialized are still logged.
  const LOG_ENTRIES = 1000;
  const LOG_ENTRY_CHARACTERS = 16_384;
  const logText = (value) => {
    try {
      return typeof value === 'string' ? value : (stringify(value) ?? String(value));
    } catch {
      try {
        return String(value);
      } catch {
        return '[unserializable value]';
      }
    }
  };
  globalThis.console = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
      level,
      (...items) => {
        if (state.logs.length >= LOG_ENTRIES) return;
        let room = LOG_ENTRY_CHARACTERS;
        const values = [];
        for (const item of items) {
          if (room <= 0) break;
          const text = logText(item);
          values.push(
            text.length > room
              ? `${text.slice(0, room)}… [${text.length - room} more characters]`
              : text,
          );
          room -= Math.max(text.length, 1);
        }
        state.logs.push({ level, values, iteration: state.iteration });
      },
    ]),
  );
  Object.defineProperty(globalThis, '__nexo', {
    value: Object.freeze({
      snapshot: () =>
        stringify({
          ...state,
          queue: undefined,
          mongo: undefined,
          callbacks: undefined,
          request: {
            ...state.request,
            method: api.request.method,
            url: api.request.url,
            body: api.request.body,
          },
        }),
      replace: (value) => stringify(replace(value, scriptScopes, true)),
      queue: () => {
        const queue = state.queue;
        state.queue = [];
        return stringify(queue);
      },
      mongoQueue: () => {
        const queue = state.mongo;
        state.mongo = [];
        return stringify(queue);
      },
      deliverMongo,
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
})
