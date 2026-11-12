/**
 * What request scripts can use, as `pm` (Postman's name) and `nx`: the same object in the
 * QuickJS sandbox (`backend/crates/nexo-engine/src/scripts/bootstrap/`). The editor
 * suggests these members as one types `pm.` or `nx.`.
 */
export interface ScriptMember {
  name: string;
  kind: 'property' | 'method' | 'object';
  /** How it is called or what it holds, shown next to the name. */
  signature: string;
  doc: string;
  /** Members of the object, for `name.`. */
  members?: ScriptMember[];
  /** Members of what a call returns, for `name(…).`. */
  returns?: ScriptMember[];
}

const method = (
  name: string,
  signature: string,
  doc: string,
  returns?: ScriptMember[],
): ScriptMember => ({ name, kind: 'method', signature, doc, ...(returns ? { returns } : {}) });
const property = (name: string, signature: string, doc: string): ScriptMember => ({
  name,
  kind: 'property',
  signature,
  doc,
});
const object = (name: string, doc: string, members: ScriptMember[]): ScriptMember => ({
  name,
  kind: 'object',
  signature: '',
  doc,
  members,
});

/** What a collection of `nx.mongo(name).db(database).collection(name)` can do. */
const MONGO_COLLECTION: ScriptMember[] = [
  method('findOne', '(filter?, options?) → Promise', 'The first document that matches, or null.'),
  method(
    'find',
    '(filter?, options?) → cursor',
    'Documents that match: sort, limit, skip, project, then toArray() (1 000 at most).',
  ),
  method('countDocuments', '(filter?) → Promise', 'How many documents match.'),
  method(
    'aggregate',
    '(pipeline, options?) → cursor',
    'An aggregation that reads; toArray() gives its documents.',
  ),
  method(
    'insertOne',
    '(document) → Promise',
    'Inserts a document; refused on a read-only connection.',
  ),
  method('insertMany', '(documents) → Promise', 'Inserts several documents.'),
  method('updateOne', '(filter, update) → Promise', 'Updates the first document that matches.'),
  method('updateMany', '(filter, update) → Promise', 'Updates every document that matches.'),
  method('replaceOne', '(filter, document) → Promise', 'Replaces the first document that matches.'),
  method('deleteOne', '(filter) → Promise', 'Deletes the first document that matches.'),
  method(
    'deleteMany',
    '(filter, options?) → Promise',
    'Deletes every match; an empty filter needs { confirm: collection }.',
  ),
];
const MONGO_DATABASE = method('db', '(name) → database', 'A database of the connection.', [
  method('collection', '(name) → collection', 'A collection of the database.', MONGO_COLLECTION),
  method('getCollection', '(name) → collection', 'The same as collection.', MONGO_COLLECTION),
]);

/** A variable scope: environment, globals, collection variables… */
function scope(readOnly: boolean): ScriptMember[] {
  const read = [
    method('get', '(key) → value', 'The value of a variable, or undefined.'),
    method('has', '(key) → boolean', 'Whether the variable exists.'),
    method('toObject', '() → object', 'Every variable, as an object.'),
    method('replaceIn', '(text) → string', 'Text with its {{variables}} replaced.'),
  ];
  return readOnly
    ? read
    : [
        ...read,
        method('set', '(key, value)', 'Sets a variable, saved when the request ends.'),
        method('unset', '(key)', 'Removes a variable.'),
        method('clear', '()', 'Removes every variable.'),
      ];
}
const headers = (editable: boolean): ScriptMember[] => [
  method('get', '(name) → string', 'The value of a header, whatever its case.'),
  method('has', '(name) → boolean', 'Whether the header is there.'),
  method('all', '() → array', 'Every header as {key, value} rows.'),
  method('toObject', '() → object', 'Every header, as an object.'),
  ...(editable
    ? [
        method('add', '({key, value})', 'Adds a header.'),
        method('upsert', '({key, value})', 'Adds a header or replaces the one with that name.'),
        method('remove', '(name)', 'Removes a header.'),
      ]
    : []),
];

/** What `expect(value)` chains: Chai's BDD words and assertions. */
const assertions: ScriptMember[] = (() => {
  const chain: ScriptMember[] = [];
  const words = [
    'to',
    'be',
    'been',
    'is',
    'that',
    'which',
    'and',
    'has',
    'have',
    'with',
    'at',
    'of',
    'same',
  ].map((name) => property(name, 'chain', 'Reads well; it changes nothing.'));
  const checks = [
    method('equal', '(expected)', 'Strictly equal (===).'),
    method('eql', '(expected)', 'Deeply equal.'),
    method('include', '(value)', 'Contains the value, the text or the properties.'),
    method('property', '(name, value?)', 'Has the property, with that value if given.', chain),
    method('lengthOf', '(size)', 'Has that length.'),
    method('match', '(pattern)', 'Matches the regular expression.'),
    method('above', '(value)', 'Greater than the value.'),
    method('below', '(value)', 'Less than the value.'),
    method('least', '(value)', 'Greater than or equal to the value.'),
    method('most', '(value)', 'Less than or equal to the value.'),
    method('within', '(min, max)', 'Between both values, included.'),
    method('oneOf', '(list)', 'One of the values of the list.'),
    method('keys', '(...keys)', 'Has exactly these keys.'),
    method('members', '(items)', 'Has exactly these items, in any order.'),
    method('a', '(type)', 'Of that type: string, number, object, array, null…'),
    method('an', '(type)', 'Of that type: object, array…'),
    method('throw', '()', 'The function throws.'),
  ];
  const states = ['ok', 'true', 'false', 'null', 'undefined', 'exist', 'empty'].map((name) =>
    property(name, 'assertion', `The value is ${name === 'ok' ? 'truthy' : name}.`),
  );
  chain.push(
    ...words,
    property('not', 'chain', 'Negates the assertion that follows.'),
    property('deep', 'chain', 'Compares deeply in the assertion that follows.'),
    ...checks,
    ...states,
  );
  for (const word of chain)
    if (word.kind === 'property' && word.signature === 'chain') word.members = chain;
  return chain;
})();

const response: ScriptMember[] = [
  property('code', 'number', 'The status code, such as 200.'),
  property('status', 'string', 'The status text, such as OK.'),
  property('responseTime', 'number', 'How long the response took, in milliseconds.'),
  property('responseSize', 'number', 'The size of the response, in bytes.'),
  object('headers', 'The response headers.', headers(false)),
  method('text', '() → string', 'The body as text.'),
  method('json', '() → object', 'The body parsed as JSON.'),
  object('cookies', 'The cookies the response set.', [
    method('toObject', '() → object', 'Every cookie, as an object.'),
  ]),
  object('to', 'Assertions on the response.', [
    object('have', 'What the response has.', [
      method('status', '(code)', 'The status code is this one.'),
      method('header', '(name, value?)', 'The header is there, with that value if given.'),
      method('body', '(text)', 'The body is this text.'),
      method('jsonBody', '(key?, value?)', 'The body is JSON, with that value at the key.'),
    ]),
    object('be', 'What the response is.', [
      method('json', '()', 'The body is JSON.'),
      method('successful', '()', 'The status is 2xx.'),
      method('error', '()', 'The status is 4xx or 5xx.'),
    ]),
  ]),
];

/** The members of `pm` and `nx`. */
export const SCRIPT_API: ScriptMember[] = [
  object('environment', 'Variables of the active environment.', scope(false)),
  object('globals', 'Global variables of the workspace.', scope(false)),
  object('collectionVariables', 'Variables of the collection.', scope(false)),
  object(
    'iterationData',
    'The row of the runner data for this iteration (read only).',
    scope(true),
  ),
  object('variables', 'Every scope at once: local, data, environment, collection, globals.', [
    ...scope(false),
  ]),
  object('info', 'About the request being run.', [
    property('iteration', 'number', 'The iteration of the run, from 0.'),
    property('iterationCount', 'number', 'How many iterations the run has.'),
    property('requestName', 'string', 'The name of the request.'),
    property('requestId', 'string', 'The ID of the request.'),
  ]),
  object('request', 'The request about to be sent; pre-request scripts can change it.', [
    property('url', 'string | object', 'The URL of the request.'),
    property('method', 'string', 'The HTTP method.'),
    property('body', 'object', 'The body of the request.'),
    object('headers', 'The request headers.', headers(true)),
  ]),
  object('response', 'The response, in test scripts.', response),
  {
    ...method('test', '(name, fn)', 'A named test: it passes unless fn throws.'),
    members: [method('skip', '(name)', 'A test listed as skipped.')],
  },
  method(
    'expect',
    '(value) → assertion',
    'Chai assertions: pm.expect(value).to.equal(1).',
    assertions,
  ),
  object('execution', 'Controls the run.', [
    method('setNextRequest', '(name)', 'The request the runner sends next; null ends the run.'),
    method('skipRequest', '()', 'Skips this request, from its pre-request script.'),
  ]),
  object('oauth2', 'OAuth 2.0 tokens; never readable from scripts.', [
    method('reset', '(name)', 'Deletes the token with that name, so the next send gets a new one.'),
  ]),
  method('sendRequest', '(request, callback?) → Promise', 'Sends another request from the script.'),
  method(
    'mongo',
    '(connection) → client',
    'A saved MongoDB connection, by its name; the script never sees its URI or password.',
    [MONGO_DATABASE],
  ),
];

/** The script globals: `pm`, as in Postman, and `nx`. */
export const SCRIPT_ROOTS: ScriptMember[] = [
  object('pm', 'The script API, by the name Postman gives it.', SCRIPT_API),
  object('nx', 'The script API of Nexo (the same as pm).', SCRIPT_API),
];

/** A step of a member path: a name, called or not (`json()`). */
export interface PathStep {
  name: string;
  call: boolean;
}

/**
 * The member path written just before the cursor, such as `pm.expect(x).to.` with `eq`
 * typed: the steps, what is typed of the next name, and where that starts. `undefined`
 * when the text before is not a member path.
 */
export function pathBefore(
  text: string,
): { steps: PathStep[]; typed: string; from: number } | undefined {
  const typed = /[\w$]*$/.exec(text)![0];
  const from = text.length - typed.length;
  let at = from;
  if (text[at - 1] !== '.') return { steps: [], typed, from };
  const steps: PathStep[] = [];
  at -= 1;
  for (;;) {
    let call = false;
    if (text[at - 1] === ')') {
      let depth = 0;
      let index = at - 1;
      for (; index >= 0; index--) {
        if (text[index] === ')') depth++;
        else if (text[index] === '(' && --depth === 0) break;
      }
      if (index < 0) return undefined;
      at = index;
      call = true;
    }
    const name = /[\w$]*$/.exec(text.slice(0, at))![0];
    if (!name) return undefined;
    steps.unshift({ name, call });
    at -= name.length;
    if (text[at - 1] !== '.') break;
    at -= 1;
  }
  return { steps, typed, from };
}

/** The members that can follow a path: `pm.response.` gives the response's. */
export function membersAfter(steps: readonly PathStep[]): ScriptMember[] | undefined {
  let members: ScriptMember[] | undefined = SCRIPT_ROOTS;
  for (const step of steps) {
    const member: ScriptMember | undefined = members?.find((m) => m.name === step.name);
    if (!member) return undefined;
    members = step.call ? member.returns : member.members;
  }
  return members;
}
