// The MongoDB shell, on top of the script API: `db` as mongosh has it (`db.orders.find()`,
// `db.getSiblingDB(…)`), `use`, `show`, `print` and `printjson`. Every call goes through
// `nx.mongo` with the connection of the shell; its URI never enters this context. The engine
// calls this function with the shell's settings.
(function shell(config) {
  const client = nx.mongo(config.connection);
  const output = { database: config.database };
  const databaseOf = (name) =>
    new Proxy(
      {},
      {
        get(_, key) {
          if (typeof key !== 'string') return undefined;
          const handle = client.db(name);
          if (key === 'getSiblingDB') return (other) => databaseOf(String(other));
          if (key === 'toString' || key === 'getName') return () => name;
          if (Object.hasOwn(handle, key)) return handle[key];
          return handle.collection(key);
        },
      },
    );
  Object.defineProperty(globalThis, 'db', { get: () => databaseOf(output.database) });
  globalThis.use = (name) => {
    output.database = String(name);
    return `switched to db ${output.database}`;
  };
  globalThis.show = (what) => {
    if (what === 'dbs' || what === 'databases')
      return client.listDatabases().then((list) => list.map((database) => database.name));
    if (what === 'collections' || what === 'tables')
      return databaseOf(output.database).getCollectionNames();
    throw new TypeError(`show ${what} is not known: use show dbs or show collections`);
  };
  globalThis.print = (...values) => console.log(...values);
  globalThis.printjson = (value) => console.log(EJSON.stringify(value, null, 2));
  Object.defineProperty(globalThis, '__shell', {
    value: Object.freeze({
      /** What the command gave: a cursor's first documents, a promise's value, or itself. */
      settle: (value) => {
        let result = value;
        if (value && typeof value.toArray === 'function' && typeof value.then !== 'function') {
          const limit = value.options?.().limit;
          output.kind = 'documents';
          result = (limit === undefined && value.limit ? value.limit(config.shown) : value).toArray();
        }
        Promise.resolve(result).then(
          (settled) => {
            output.kind ??= settled === undefined ? 'none' : 'value';
            output.value = EJSON.serialize(settled);
          },
          (error) => {
            output.error = error?.message ?? String(error);
          },
        );
      },
      output: () => JSON.stringify(output),
    }),
  });
})
