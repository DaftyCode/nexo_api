import {
  asCollection,
  fromItem,
  toItem,
  updateItem,
  newRequest,
  schema,
  encodeQueryPart,
  splitQuery,
  RequestDraft,
  Run,
  mergeRun,
  pathVariableNames,
  requestFiles,
  AttachedFile,
} from './models';
describe('Collection editing', () => {
  it('preserves examples and unknown item metadata while editing a request', () => {
    const item = {
      name: 'Original',
      request: { method: 'GET', url: 'https://example.test', description: 'Keep this' },
      response: [{ name: 'Example' }],
      custom: { enabled: true },
    };
    const request = fromItem(item, 'id');
    request.name = 'Updated';
    const saved = toItem(request, item);
    expect(saved['response']).toEqual(item.response);
    expect(saved['custom']).toEqual(item.custom);
    expect((saved.request as Record<string, unknown>)['description']).toBe('Keep this');
  });
  it('updates nested folder requests without mutating the original collection', () => {
    const source = {
      info: { name: 'Fixture', schema },
      item: [
        {
          name: 'Folder',
          item: [{ name: 'Old', request: { method: 'GET', url: 'https://example.test' } }],
        },
      ],
    };
    const next = updateItem(source, [0, 0], { name: 'Changed' });
    expect(source.item[0].item[0].name).toBe('Old');
    expect(next.item[0].item?.[0].name).toBe('Changed');
  });
  it('represents disabled headers and test scripts in the portable format', () => {
    const request = newRequest('a');
    request.headers = [{ key: 'X-Disabled', value: 'x', enabled: false }];
    request.tests = 'pm.test("status",()=>{});';
    const item = toItem(request);
    expect((item.request as Record<string, unknown>)['header']).toEqual([
      { key: 'X-Disabled', value: 'x', disabled: true },
    ]);
    expect(item.event?.[1].script.exec).toEqual([request.tests]);
  });
  it('rejects invalid collections at the domain boundary', () => {
    expect(() => asCollection({ info: {} })).toThrow('Invalid collection');
  });
});

describe('query parameters', () => {
  it('keep variable placeholders while encoding the rest', () => {
    expect(encodeQueryPart('{{tenant}}')).toBe('{{tenant}}');
    expect(encodeQueryPart('a b&{{x}}')).toBe('a%20b%26{{x}}');
  });
});

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

describe('incremental runs', () => {
  it('appends only the entries received after the cursor', () => {
    const first = {
      id: 'r',
      state: 'running',
      results: [{ status: 200 }],
      assertions: [],
      logs: ['a'],
      counts: { results: 1, assertions: 0, logs: 1 },
    } as unknown as Run;
    const update = {
      id: 'r',
      state: 'completed',
      results: [{ status: 201 }],
      assertions: [{ name: 't', passed: true }],
      logs: [],
      counts: { results: 2, assertions: 1, logs: 1 },
    } as unknown as Run;
    const merged = mergeRun(first, update);
    expect(merged.results.map((r) => r.status)).toEqual([200, 201]);
    expect(merged.logs).toEqual(['a']);
    expect(merged.state).toBe('completed');
    expect(merged.counts).toEqual({ results: 2, assertions: 1, logs: 1 });
  });
});

describe('protocol requests in collections', () => {
  const settings = {
    protocol: 'grpc' as const,
    url: 'localhost:50051',
    message: '',
    grpcMessage: '{"name":"Nexo"}',
    topic: '',
    event: 'message',
    proto: 'syntax = "proto3"; service Greeter { rpc Hello (A) returns (B); }',
    service: 'demo.Greeter',
    method: 'Hello',
    metadata: '[]',
    tls: false,
    strictSSL: true,
    caPem: '',
    username: 'user',
    password: 'literal-secret',
    qos: '0',
    headers: [],
  };
  it('reopen with their proto, service and method, without literal passwords', () => {
    const draft = newRequest('g1');
    draft.realtime = settings;
    draft.protocol = 'grpc';
    const item = toItem(draft);
    expect(JSON.stringify(item)).not.toContain('literal-secret');
    const reopened = fromItem(item, 'g1');
    expect(reopened.protocol).toBe('grpc');
    expect(reopened.realtime).toMatchObject({
      proto: settings.proto,
      service: 'demo.Greeter',
      method: 'Hello',
      password: '',
    });
  });
  it('keep password references to variables', () => {
    const draft = newRequest('m1');
    draft.realtime = { ...settings, protocol: 'mqtt', password: '{{vault:mqtt}}' };
    expect(fromItem(toItem(draft), 'm1').realtime?.password).toBe('{{vault:mqtt}}');
  });
});

describe('Files sent with a request', () => {
  const attached = (name: string, size = 3): AttachedFile => ({
    name,
    contentType: 'image/png',
    size,
    content: 'AQID',
  });

  it('keeps Postman file fields and binary bodies by name only', () => {
    const item = {
      name: 'Upload',
      request: {
        method: 'POST',
        url: 'https://x.test',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'note', value: 'hi', type: 'text', contentType: 'text/plain' },
            { key: 'avatar', type: 'file', src: '/home/ana/avatar.png' },
            { key: 'docs', type: 'file', src: ['a.pdf', 'b.pdf'], disabled: true },
            { key: 'empty', type: 'file', src: null },
          ],
        },
      },
    };
    const draft = fromItem(item, 'u');
    expect(draft.form.map((row) => [row.key, row.type, row.src, row.contentType])).toEqual([
      ['note', undefined, undefined, 'text/plain'],
      ['avatar', 'file', '/home/ana/avatar.png', undefined],
      ['docs', 'file', ['a.pdf', 'b.pdf'], undefined],
      ['empty', 'file', '', undefined],
    ]);
    draft.form[1].files = [attached('avatar.png')];
    const saved = toItem(draft, item);
    const rows = (saved.request as { body: { formdata: unknown[] } }).body.formdata;
    expect(rows).toEqual([
      { key: 'note', value: 'hi', type: 'text', contentType: 'text/plain', disabled: false },
      { key: 'avatar', type: 'file', src: '/home/ana/avatar.png', disabled: false },
      { key: 'docs', type: 'file', src: ['a.pdf', 'b.pdf'], disabled: true },
      { key: 'empty', type: 'file', src: null, disabled: false },
    ]);
    expect(JSON.stringify(saved)).not.toContain('AQID');

    const binary = fromItem(
      {
        name: 'Put',
        request: { method: 'PUT', body: { mode: 'file', file: { src: 'data.bin' } } },
      },
      'b',
    );
    expect([binary.bodyMode, binary.bodyFile]).toEqual(['file', { src: 'data.bin' }]);
    binary.bodyFile = { src: 'data.bin', file: attached('data.bin') };
    expect((toItem(binary).request as { body: unknown }).body).toEqual({
      mode: 'file',
      file: { src: 'data.bin' },
    });
  });

  it('sends the files chosen, in the order of their fields, within the size limit', () => {
    const draft = newRequest('f');
    draft.bodyMode = 'formdata';
    draft.form = [
      {
        key: 'one',
        value: '',
        enabled: true,
        type: 'file',
        src: 'a.png',
        files: [attached('a.png')],
      },
      {
        key: 'off',
        value: '',
        enabled: false,
        type: 'file',
        src: 'x.png',
        files: [attached('x.png')],
      },
      {
        key: 'two',
        value: '',
        enabled: true,
        type: 'file',
        src: ['b.png', 'c.png'],
        files: [attached('b.png')],
      },
      { key: 'text', value: 'v', enabled: true },
    ];
    expect(requestFiles(draft)).toEqual([
      { src: 'a.png', content: 'AQID', contentType: 'image/png' },
      { src: 'b.png', content: 'AQID', contentType: 'image/png' },
    ]);
    draft.bodyMode = 'file';
    draft.bodyFile = { src: 'body.bin', file: { ...attached('body.bin'), contentType: '' } };
    expect(requestFiles(draft)).toEqual([{ src: 'body.bin', content: 'AQID' }]);
    draft.bodyFile = { src: 'body.bin', file: attached('body.bin', 33 * 1024 * 1024) };
    expect(() => requestFiles(draft)).toThrow('Files sent with a request can add up to 32 MB');
    draft.protocol = 'graphql';
    expect(requestFiles(draft)).toEqual([]);
  });
});
