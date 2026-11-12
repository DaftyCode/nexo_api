import {
  fromItem,
  newRequest,
  pathVariableNames,
  RequestDraft,
  splitQuery,
  toItem,
} from '../models';

describe('collection item conversion', () => {
  function draft(change: (d: RequestDraft) => void): RequestDraft {
    const d = newRequest('r1');
    change(d);
    return d;
  }
  const cases: [string, RequestDraft][] = [
    ['plain GET', draft((d) => (d.url = 'https://api.test/users'))],
    [
      'query rows with placeholders and encoded text',
      draft((d) => {
        d.url = '{{base}}/search';
        d.query = [
          { key: 'q', value: 'a b&c', enabled: true },
          { key: 'tenant', value: '{{tenant}}', enabled: true },
          { key: 'debug', value: '1', enabled: false },
        ];
      }),
    ],
    [
      'JSON body, headers and bearer auth',
      draft((d) => {
        d.method = 'POST';
        d.url = 'https://api.test/items';
        d.headers = [
          { key: 'X-Trace', value: '1', enabled: true },
          { key: 'X-Off', value: '0', enabled: false },
        ];
        d.body = '{"ñ":1}';
        d.auth.type = 'bearer';
        d.auth.token = '{{token}}';
        d.prerequest = 'pm.variables.set("a", 1);';
        d.tests = ['pm.test("ok", () => {});', 'console.log(1);'].join('\n');
      }),
    ],
    [
      'form body and basic auth',
      draft((d) => {
        d.method = 'PUT';
        d.url = 'https://api.test/form';
        d.bodyMode = 'urlencoded';
        d.form = [{ key: 'name', value: 'Ana', enabled: true }];
        d.auth.type = 'basic';
        d.auth.username = 'u';
        d.auth.password = 'p';
      }),
    ],
    [
      'GraphQL with an API key in the query',
      draft((d) => {
        d.protocol = 'graphql';
        d.method = 'POST';
        d.url = 'https://api.test/graphql';
        d.body = '{ me { id } }';
        d.graphqlVariables = '{"a":1}';
        d.auth.type = 'apikey';
        d.auth.key = 'key';
        d.auth.value = 'secret';
        d.auth.in = 'query';
      }),
    ],
  ];
  const significant = (d: RequestDraft) => ({
    method: d.method,
    url: d.url,
    headers: d.headers.filter((h) => h.key),
    query: d.query.filter((q) => q.key),
    body: d.body,
    bodyMode: d.bodyMode,
    form: d.bodyMode === 'raw' ? [] : d.form.filter((f) => f.key),
    protocol: d.protocol,
    graphqlVariables: d.protocol === 'graphql' ? d.graphqlVariables : '{}',
    auth: {
      type: d.auth.type,
      token: d.auth.token,
      username: d.auth.username,
      password: d.auth.password,
      key: d.auth.key,
      value: d.auth.value,
      in: d.auth.in,
    },
    prerequest: d.prerequest,
    tests: d.tests,
  });
  for (const [name, original] of cases)
    it(`round-trips ${name}`, () => {
      const item = toItem(original);
      expect(significant(fromItem(item, original.id))).toEqual(significant(original));
      expect(toItem(fromItem(item, original.id), item)).toEqual(item);
    });
  it('opens a Postman export with its path variables, body format and body type', () => {
    const exported = {
      name: 'cache',
      protocolProfileBehavior: { disableBodyPruning: true },
      request: {
        method: 'POST',
        header: [],
        body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } },
        url: {
          raw: 'http://localhost:8080/v1/contexto/:clave?ramo=6',
          protocol: 'http',
          host: ['localhost'],
          port: '8080',
          path: ['v1', 'contexto', ':clave'],
          query: [{ key: 'ramo', value: '6' }],
          variable: [{ key: 'clave', value: 'k1' }],
        },
      },
    };
    const draft = fromItem(exported, 'r1');
    expect(draft.url).toBe('http://localhost:8080/v1/contexto/:clave');
    expect(draft.pathVariables).toEqual([{ key: 'clave', value: 'k1', enabled: true }]);
    expect(draft.bodyLanguage).toBe('xml');
    expect(draft.body).toBe('<a/>');
    const saved = toItem(
      { ...draft, pathVariables: [{ key: 'clave', value: 'k2', enabled: true }] },
      exported,
    );
    expect(saved.request).toMatchObject({
      url: {
        raw: 'http://localhost:8080/v1/contexto/:clave?ramo=6',
        variable: [{ key: 'clave', value: 'k2' }],
      },
      body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } },
    });
    expect(saved['protocolProfileBehavior']).toEqual({ disableBodyPruning: true });
    // Without path variables the URL stays text.
    expect(
      toItem({ ...draft, url: 'http://x/a', query: [], pathVariables: [] }).request,
    ).toMatchObject({
      url: 'http://x/a',
    });
  });

  it('keeps a body Nexo does not edit and writes an empty one', () => {
    const file = {
      name: 'upload',
      request: { method: 'POST', url: 'http://x', body: { mode: 'file', file: { src: 'a.bin' } } },
    };
    const draft = fromItem(file, 'r2');
    expect(draft.bodyMode).toBe('file');
    expect(toItem(draft, file).request).toMatchObject({
      body: { mode: 'file', file: { src: 'a.bin' } },
    });
    expect(toItem({ ...draft, bodyMode: 'none' }, file).request).toMatchObject({
      body: { mode: 'none' },
    });
  });

  it('finds the path variables of a URL, not its port or query', () => {
    expect(pathVariableNames('http://localhost:8080/v1/:a/x/:b/:a?q=:c#:d')).toEqual(['a', 'b']);
    expect(pathVariableNames('{{base}}/users/:id')).toEqual(['id']);
    expect(pathVariableNames('http://host:8080')).toEqual([]);
    expect(pathVariableNames('/a/:')).toEqual([]);
  });

  it('keeps URLs whose query cannot be written back identically', () => {
    for (const url of [
      'https://x/a?b=1+2',
      'https://x/a?flag',
      'https://x/a?b=1#top',
      'https://x/a?b=%41',
    ])
      expect(splitQuery(url)).toEqual({ url, query: [] });
    expect(splitQuery('https://x/a?b=a%20b&c={{v}}')).toEqual({
      url: 'https://x/a',
      query: [
        { key: 'b', value: 'a b', enabled: true },
        { key: 'c', value: '{{v}}', enabled: true },
      ],
    });
  });
  it('reports invalid authorization parameters clearly', () => {
    const d = draft((x) => {
      x.auth.type = 'oauth2';
      x.auth.parameters = '{oops';
    });
    expect(() => toItem(d)).toThrowError('Authorization parameters must be a JSON object');
  });
});
