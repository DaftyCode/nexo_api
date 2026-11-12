  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
  // BSON values written as the MongoDB shell writes them (ObjectId, ISODate, NumberLong…),
  // and `nx.mongo`: calls queued for the engine with the name of a saved connection only.
  // Results arrive in canonical Extended JSON and become these values; arguments go back as
  // Extended JSON, so every type makes the round trip.
  const INT32 = 2 ** 31;
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const base64 = (bytes) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const [a, b = 0, c = 0] = bytes.slice(i, i + 3);
      const n = (a << 16) | (b << 8) | c;
      text += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
      text += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
      text += i + 2 < bytes.length ? BASE64[n & 63] : '=';
    }
    return text;
  };
  const randomHex = (length) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  let objectIdCounter = Math.floor(Math.random() * 0x1000000);
  /** A BSON value whose own field is its Extended JSON, callable with or without `new`. */
  function bsonType(name, key, read, number) {
    const Type = function (...values) {
      if (!(this instanceof Type)) return new Type(...values);
      this[key] = read(...values);
    };
    Object.defineProperty(Type, 'name', { value: name });
    Type.prototype.toString = function () {
      const value = this[key];
      return typeof value === 'object' ? stringify(value) : String(value);
    };
    if (number) Type.prototype.valueOf = function () { return Number(this[key]); };
    return Type;
  }
  const ObjectId = bsonType('ObjectId', '$oid', (value) => {
    let text = value?.$oid ?? value;
    if (text === undefined) {
      objectIdCounter = (objectIdCounter + 1) % 0x1000000;
      text = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomHex(10) +
        objectIdCounter.toString(16).padStart(6, '0');
    }
    if (!/^[0-9a-fA-F]{24}$/.test(String(text)))
      throw new TypeError('An ObjectId is 24 hexadecimal characters');
    return String(text).toLowerCase();
  });
  ObjectId.prototype.toHexString = function () { return this.$oid; };
  ObjectId.prototype.equals = function (other) {
    return String(other?.$oid ?? other).toLowerCase() === this.$oid;
  };
  ObjectId.prototype.getTimestamp = function () {
    return new Date(parseInt(this.$oid.slice(0, 8), 16) * 1000);
  };
  const NumberLong = bsonType('NumberLong', '$numberLong', (value = 0) => {
    const text = String(value);
    if (!/^-?\d+$/.test(text)) throw new TypeError('A NumberLong is a whole number');
    return text;
  }, true);
  const NumberInt = bsonType('NumberInt', '$numberInt', (value = 0) => {
    const number = Math.trunc(Number(value));
    if (!(number >= -INT32 && number < INT32)) throw new TypeError('A NumberInt fits in 32 bits');
    return String(number);
  }, true);
  const NumberDecimal = bsonType('NumberDecimal', '$numberDecimal', (value = '0') => String(value));
  const Timestamp = bsonType('Timestamp', '$timestamp', (t = 0, i = 0) =>
    typeof t === 'object' ? { t: Number(t.t ?? 0), i: Number(t.i ?? 0) } : { t: Number(t), i: Number(i) },
  );
  const BinData = bsonType('BinData', '$binary', (subType = 0, data = '') => ({
    base64: String(data),
    subType: Number(subType).toString(16).padStart(2, '0'),
  }));
  const UUID = (text = randomHex(32)) => {
    const digits = String(text).replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(digits)) throw new TypeError('A UUID is 32 hexadecimal digits');
    const bytes = digits.match(/../g).map((pair) => parseInt(pair, 16));
    return BinData(4, base64(bytes));
  };
  const MinKey = bsonType('MinKey', '$minKey', () => 1);
  const MaxKey = bsonType('MaxKey', '$maxKey', () => 1);
  const ISODate = (text) => {
    const date = text === undefined ? new Date() : new Date(text);
    if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${text}`);
    return date;
  };

  /** A value as Extended JSON: dates, regular expressions and big integers made explicit. */
  const toBson = (value) => {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return { $date: { $numberLong: String(value.getTime()) } };
    if (value instanceof RegExp)
      return {
        $regularExpression: {
          pattern: value.source,
          options: value.flags.replace(/[^imsxu]/g, '').split('').sort().join(''),
        },
      };
    if (typeof value === 'bigint') return { $numberLong: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $numberDouble: String(value) };
    if (Array.isArray(value)) return value.map(toBson);
    if (typeof value === 'object') {
      const document = {};
      for (const [key, item] of Object.entries(value))
        if (item !== undefined && typeof item !== 'function') document[key] = toBson(item);
      return document;
    }
    return value;
  };
  /** Canonical Extended JSON as script values: numbers, dates and the types above. */
  const fromBson = (value) => {
    if (Array.isArray(value)) return value.map(fromBson);
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    const inner = value[keys[0]];
    if (keys.length === 1)
      switch (keys[0]) {
        case '$oid':
          return ObjectId(inner);
        case '$date':
          return new Date(typeof inner === 'object' ? Number(inner.$numberLong) : Date.parse(inner));
        case '$numberInt':
        case '$numberDouble':
          return Number(inner);
        case '$numberLong':
          return Number.isSafeInteger(Number(inner)) ? Number(inner) : NumberLong(inner);
        case '$numberDecimal':
          return NumberDecimal(inner);
        case '$binary':
          return Object.assign(Object.create(BinData.prototype), { $binary: inner });
        case '$timestamp':
          return Timestamp(inner);
        case '$regularExpression':
          try {
            return new RegExp(inner.pattern, inner.options.replace(/[^imsu]/g, ''));
          } catch {
            return value;
          }
        case '$minKey':
          return MinKey();
        case '$maxKey':
          return MaxKey();
        case '$symbol':
          return inner;
        case '$undefined':
          return undefined;
      }
    return Object.fromEntries(keys.map((key) => [key, fromBson(value[key])]));
  };

  state.mongo = [];
  const mongoCall = (connection, database, collection, method, args) =>
    new Promise((resolve, reject) => {
      const id = String(Object.keys(state.callbacks).length);
      state.callbacks[id] = { resolve, reject };
      state.mongo.push({
        id,
        call: { connection, database, collection, method, arguments: args.map(toBson) },
      });
    });
  /** `find(...)` and `aggregate(...)` as the shell has them: options chained, then `toArray()`. */
  const cursor = (run, options) => {
    const chain = {
      sort: (sort) => ((options.sort = sort), chain),
      limit: (limit) => ((options.limit = limit), chain),
      skip: (skip) => ((options.skip = skip), chain),
      project: (projection) => ((options.projection = projection), chain),
      toArray: () => run(options),
    };
    return chain;
  };
  const mongoCollection = (connection, database, name) => {
    const call = (method, ...args) => mongoCall(connection, database, name, method, args);
    return Object.freeze({
      findOne: (filter = {}, options = {}) => call('findOne', filter, options),
      find: (filter = {}, options = {}) => cursor((chosen) => call('find', filter, chosen), { ...options }),
      countDocuments: (filter = {}) => call('countDocuments', filter),
      aggregate: (pipeline = [], options = {}) => ({ toArray: () => call('aggregate', pipeline, options) }),
      insertOne: (document) => call('insertOne', document),
      insertMany: (documents) => call('insertMany', documents),
      updateOne: (filter, update) => call('updateOne', filter, update),
      updateMany: (filter, update) => call('updateMany', filter, update),
      replaceOne: (filter, replacement) => call('replaceOne', filter, replacement),
      deleteOne: (filter) => call('deleteOne', filter),
      deleteMany: (filter, options = {}) => call('deleteMany', filter, options),
    });
  };
  api.mongo = (connection) => {
    const name = String(connection ?? '');
    if (!name) throw new TypeError('nx.mongo needs the name of a saved connection');
    const db = (database) => {
      const collection = (collection) => mongoCollection(name, String(database), String(collection));
      return Object.freeze({ collection, getCollection: collection });
    };
    return Object.freeze({ db, getDB: db });
  };
  Object.assign(globalThis, {
    ObjectId,
    ISODate,
    NumberLong,
    NumberInt,
    NumberDecimal,
    Timestamp,
    BinData,
    UUID,
    MinKey,
    MaxKey,
  });
  const deliverMongo = (id, result, error) => {
    const entry = state.callbacks[id];
    if (error) entry.reject(new Error(error));
    else entry.resolve(fromBson(result));
  };
