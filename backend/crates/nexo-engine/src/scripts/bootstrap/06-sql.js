  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
  // `nx.sql` (DB-32): calls queued for the engine with the name of a saved connection of a
  // database module only, answered by the application with the rules of the SQL editor.
  // Parameters always travel bound, never written into the statement. Values arrive as
  // JavaScript values where nothing is lost (numbers, text, booleans, `Date` for a moment
  // with its zone, `null`) and as `SqlValue` (`{ $t, v }`) where something would be.
  /** A value of a kind JavaScript has no type for: decimals, big integers, intervals… */
  function SqlValue(kind, text) {
    if (!(this instanceof SqlValue)) return new SqlValue(kind, text);
    this.$t = String(kind);
    this.v = text;
  }
  SqlValue.prototype.toString = function () {
    return Array.isArray(this.v) ? this.v.join(',') : String(this.v);
  };
  SqlValue.prototype.toJSON = function () {
    return this.v;
  };
  SqlValue.prototype.valueOf = function () {
    return ['integer', 'decimal', 'float'].includes(this.$t) ? Number(this.v) : this.v;
  };
  const sqlFromWire = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sqlFromWire);
    const kind = value.$t;
    const text = value.v;
    if (value.truncated)
      return Object.assign(SqlValue(kind, text), { truncated: true, size: value.size });
    switch (kind) {
      case 'array':
        return Array.isArray(text) ? text.map(sqlFromWire) : SqlValue(kind, text);
      case 'timestamptz': {
        const date = new Date(text);
        return Number.isNaN(date.getTime()) ? SqlValue(kind, text) : date;
      }
      case 'uuid':
      case 'xml':
      case 'text':
        return text;
      default:
        return SqlValue(kind, text);
    }
  };
  const bytesOf = (value) => {
    if (typeof value === 'string') return value;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    if (!bytes || typeof bytes.length !== 'number')
      throw new TypeError('nx.sql.bytes takes bytes or their Base64');
    return base64(Array.from(bytes, (byte) => Number(byte) & 255));
  };
  const sqlToWire = (value) => {
    if (value === undefined || value === null) return null;
    if (value instanceof SqlValue)
      return { $t: value.$t, v: Array.isArray(value.v) ? value.v.map(sqlToWire) : String(value.v) };
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError('An invalid date cannot be a parameter');
      return { $t: 'timestamptz', v: value.toISOString() };
    }
    if (typeof value === 'bigint') return { $t: 'integer', v: String(value) };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { $t: 'float', v: String(value) };
      return value;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return { $t: 'array', v: value.map(sqlToWire) };
    if (value instanceof Uint8Array || value instanceof ArrayBuffer)
      return { $t: 'binary', v: bytesOf(value) };
    if (typeof value === 'object') return { $t: 'json', v: stringify(value) };
    throw new TypeError(`A ${typeof value} cannot be a parameter`);
  };
  /** Rows as objects by column name; a repeated name gets its position. */
  const sqlRows = (answer) => {
    const names = (answer.columns ?? []).map((name, at, all) =>
      all.indexOf(name) === at ? name : `${name}_${at + 1}`,
    );
    const rows = (answer.rows ?? []).map((row) =>
      Object.fromEntries(names.map((name, at) => [name, sqlFromWire(row[at])])),
    );
    Object.defineProperty(rows, 'truncated', { value: answer.truncated === true });
    Object.defineProperty(rows, 'columns', { value: names });
    return rows;
  };

  state.sql = [];
  const sqlCall = (connection, method, sql, params, options) =>
    new Promise((resolve, reject) => {
      if (!Array.isArray(params)) throw new TypeError('The parameters of a statement are an array');
      const confirm = options?.confirm;
      const id = String(Object.keys(state.callbacks).length);
      state.callbacks[id] = { resolve, reject };
      state.sql.push({
        id,
        call: {
          connection,
          method,
          sql: String(sql ?? ''),
          params: params.map(sqlToWire),
          confirm: typeof confirm === 'string' ? confirm : confirm === true,
        },
      });
    });
  const sqlClient = (name, inTransaction) => {
    const client = {
      query: (sql, params = [], options = {}) =>
        sqlCall(name, 'query', sql, params, options).then(sqlRows),
      queryOne: (sql, params = [], options = {}) =>
        sqlCall(name, 'query', sql, params, options).then((answer) => sqlRows(answer)[0] ?? null),
      execute: (sql, params = [], options = {}) =>
        sqlCall(name, 'execute', sql, params, options).then((answer) => ({
          affected: answer.affected ?? 0,
          rows: sqlRows(answer),
        })),
      transaction: async (work) => {
        if (inTransaction) throw new Error('A transaction is already open on this connection');
        if (typeof work !== 'function') throw new TypeError('A transaction runs a function');
        await sqlCall(name, 'begin', '', [], {});
        try {
          const result = await work(sqlClient(name, true));
          await sqlCall(name, 'commit', '', [], {});
          return result;
        } catch (error) {
          await sqlCall(name, 'rollback', '', [], {}).catch(() => undefined);
          throw error;
        }
      },
    };
    if (inTransaction) delete client.transaction;
    return Object.freeze(client);
  };
  const sql = (connection) => {
    const name = String(connection ?? '');
    if (!name) throw new TypeError('nx.sql needs the name of a saved connection');
    return sqlClient(name, false);
  };
  sql.numeric = (text) => SqlValue('decimal', String(text));
  sql.bytes = (value) => SqlValue('binary', bytesOf(value));
  sql.typed = (kind, text) => SqlValue(kind, text);
  api.sql = Object.freeze(sql);
  globalThis.SqlValue = SqlValue;
  const deliverSql = (id, result, error) => {
    const entry = state.callbacks[id];
    if (error) entry.reject(new Error(error));
    else entry.resolve(result ?? {});
  };
