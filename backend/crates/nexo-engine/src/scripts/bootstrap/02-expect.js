  // Part of the bootstrap function: scripts/mod.rs joins the files of this folder in order.
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
