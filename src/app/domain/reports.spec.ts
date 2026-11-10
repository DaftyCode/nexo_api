import { emptyAuth } from './auth';
import { ExecutionResponse, Run, newRequest, row } from './models';
import { collectionDocs, reportRequest, reportResponse, reportText, runReport } from './reports';
import { masked } from './sanitize';

const response = (extra: Partial<ExecutionResponse> = {}): ExecutionResponse => ({
  status: 200,
  statusText: 'OK',
  body: '{"id":1}',
  headers: [
    { key: 'Content-Type', value: 'application/json', enabled: true },
    { key: 'Set-Cookie', value: 'session=abc', enabled: true },
  ],
  time: 12,
  size: 8,
  assertions: [],
  logs: [],
  ...extra,
});

describe('reports', () => {
  it('show JSON pretty and cut long text', () => {
    expect(reportText('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', cut: false });
    expect(reportText('plain')).toEqual({ text: 'plain', cut: false });
    expect(reportText('12')).toEqual({ text: '12', cut: false });
    expect(reportText('abcdef', 3)).toEqual({ text: 'abc', cut: true });
  });

  it('hide credentials of a request and show its body by mode', () => {
    const request = {
      ...newRequest('r1'),
      name: 'Login',
      method: 'POST',
      url: '{{base}}/login',
      headers: [
        row('Authorization', 'Bearer secret-token'),
        row('Accept', 'application/json'),
        { ...row('Off', 'x'), enabled: false },
      ],
      query: [row('page', '2')],
      auth: { ...emptyAuth('bearer'), token: 'secret-token' },
      body: '{"user":"ana"}',
      bodyMode: 'raw',
    };
    const shown = reportRequest(request, 'Signs in');
    expect(shown).toMatchObject({
      name: 'Login',
      method: 'POST',
      url: '{{base}}/login',
      description: 'Signs in',
      auth: 'bearer',
      query: [row('page', '2')],
      body: { text: '{\n  "user": "ana"\n}', cut: false },
      bodyMode: 'raw',
    });
    expect(shown.headers.map((h) => [h.key, h.value])).toEqual([
      ['Authorization', masked],
      ['Accept', 'application/json'],
    ]);
    expect(JSON.stringify(shown)).not.toContain('secret-token');

    const form = reportRequest({
      ...request,
      auth: emptyAuth('inherit'),
      bodyMode: 'formdata',
      form: [row('name', 'Ana'), { ...row('photo'), type: 'file', src: ['a.png', 'b.png'] }],
    });
    expect(form.auth).toBe('');
    expect(form.body.text).toBe('name: Ana\nphoto: (file) a.png, b.png');
    expect(
      reportRequest({ ...request, bodyMode: 'file', bodyFile: { src: 'data.bin' } }).body.text,
    ).toBe('(file) data.bin');
    expect(reportRequest({ ...request, bodyMode: 'none' })).toMatchObject({
      body: { text: '' },
      bodyMode: '',
    });
  });

  it('hide credential headers of a response and leave binary bodies out', () => {
    const shown = reportResponse(response({ error: 'slow' }));
    expect(shown.headers[1].value).toBe(masked);
    expect(shown.body.text).toBe('{\n  "id": 1\n}');
    expect(shown.error).toBe('slow');
    expect(reportResponse(response({ body: 'AAAA', bodyEncoding: 'base64' }))).toMatchObject({
      binary: true,
      body: { text: '' },
    });
  });

  it('put each test of a run under its request and iteration', () => {
    const result = (name: string, iteration: number, extra: Partial<ExecutionResponse> = {}) =>
      ({
        ...response(extra),
        name,
        iteration,
        request: { method: 'GET', url: `https://api.test/${name}` },
      }) as ExecutionResponse;
    const run: Run = {
      id: 'r1',
      state: 'failed',
      error: 'Stopped',
      duration: 340,
      results: [
        result('login', 0),
        result('orders', 0, { status: 500, statusText: 'Error' }),
        result('login', 1, { error: 'timeout', status: 0 }),
        { ...response(), request: 'not an object' } as ExecutionResponse,
      ],
      assertions: [
        { name: 'ok', passed: true, skipped: false, iteration: 0, request: 'login' },
        {
          name: 'fast',
          passed: false,
          skipped: false,
          error: 'too slow',
          iteration: 1,
          request: 'login',
        },
        { name: 'later', passed: true, skipped: true, iteration: 0, request: 'orders' },
        { name: 'orphan', passed: true, skipped: false },
      ],
      logs: [],
    };
    const report = runReport(run, 'Shop');
    expect(report).toMatchObject({
      collection: 'Shop',
      state: 'failed',
      error: 'Stopped',
      duration: 340,
      totals: { requests: 4, failedRequests: 2, passed: 2, failed: 1, skipped: 1 },
    });
    expect(
      report.requests.map((r) => [r.name, r.iteration, r.assertions.map((a) => a.name)]),
    ).toEqual([
      ['login', 0, ['ok']],
      ['orders', 0, ['later']],
      ['login', 1, ['fast']],
      ['', 0, []],
    ]);
    expect(report.requests[1]).toMatchObject({ method: 'GET', status: 500, failed: true });
    expect(report.requests[3]).toMatchObject({ method: '', url: '' });
    expect(report.other.map((a) => a.name)).toEqual(['orphan']);
    expect(runReport({ ...run, error: undefined, duration: undefined }, '')).toMatchObject({
      duration: 0,
    });
  });

  it('document a collection with its folders, examples and hidden secrets', () => {
    const docs = collectionDocs({
      info: { name: 'Shop', schema: 'x', description: { content: 'The shop API' } },
      auth: { type: 'apikey' },
      variable: [
        { key: 'base', value: 'https://api.test' },
        { key: 'apiKey', value: 'k-123' },
        { key: 'hidden', value: 's', type: 'secret' },
        { key: 'ref', value: '{{vault:key}}', type: 'secret' },
        { value: 'no key' },
      ],
      item: [
        {
          name: 'Orders',
          description: 'Order endpoints',
          item: [
            {
              id: 'r1',
              name: 'List orders',
              request: {
                method: 'GET',
                url: '{{base}}/orders',
                description: 'All orders',
                header: [{ key: 'X-Api-Key', value: 'k-123' }],
              },
              response: [
                { name: 'Found', code: 200, status: 'OK', body: '"found"' },
                { name: 'Empty' },
              ],
            },
          ],
        },
        { name: 'Health', request: 'https://api.test/health' },
        { name: 'Not a request' },
      ],
    });
    expect(docs).toMatchObject({
      name: 'Shop',
      description: 'The shop API',
      auth: 'apikey',
      requests: 2,
    });
    expect(docs.variables.map((v) => [v.key, v.value])).toEqual([
      ['base', 'https://api.test'],
      ['apiKey', masked],
      ['hidden', masked],
      ['ref', '{{vault:key}}'],
    ]);
    expect(docs.entries.map((e) => [e.kind, e.depth, e.name])).toEqual([
      ['folder', 0, 'Orders'],
      ['request', 1, 'List orders'],
      ['request', 0, 'Health'],
    ]);
    expect(docs.entries[0].description).toBe('Order endpoints');
    const orders = docs.entries[1];
    expect(orders.description).toBe('All orders');
    expect(orders.request?.method).toBe('GET');
    expect(orders.examples).toEqual([
      { name: 'Found', status: '200 OK', body: { text: '"found"', cut: false } },
      { name: 'Empty', status: '', body: { text: '', cut: false } },
    ]);
    expect(docs.entries[2].request?.url).toBe('https://api.test/health');
    expect(collectionDocs({ info: { name: '', schema: 'x' }, item: [] })).toMatchObject({
      auth: '',
      variables: [],
      entries: [],
    });
  });
});
