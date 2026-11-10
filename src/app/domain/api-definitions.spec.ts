import {
  ApiPath,
  definitionSource,
  findingCounts,
  messageParams,
  searchOutline,
} from './api-definitions';

const operation = (method: string, operationId: string, summary = '', parameter = '') => ({
  method,
  operationId,
  summary,
  deprecated: false,
  pointer: `/${operationId}`,
  parameters: parameter
    ? [{ name: parameter, in: 'query', required: false, type: 'string', pointer: '/p' }]
    : [],
  requestBody: null,
  responses: [],
});
const paths: ApiPath[] = [
  {
    path: '/orders',
    pointer: '/paths/~1orders',
    operations: [
      operation('get', 'listOrders', 'List orders', 'status'),
      operation('post', 'createOrder'),
    ],
  },
  { path: '/users', pointer: '/paths/~1users', operations: [operation('delete', 'removeUser')] },
];

describe('API definitions', () => {
  it('read the source of a stored definition', () => {
    const document = (value: unknown) => ({
      id: 'a',
      workspace_id: 'w',
      kind: 'api',
      name: 'A',
      revision: 1,
      updated_at: 0,
      value,
    });
    expect(definitionSource(document({ source: 'openapi: 3.1.0' }))).toBe('openapi: 3.1.0');
    expect(definitionSource(document({ source: 1 }))).toBe('');
    expect(definitionSource(document(null))).toBe('');
    expect(definitionSource(undefined)).toBe('');
  });

  it('turn parameters into translation values and count findings', () => {
    expect(messageParams(['a', 'b'])).toEqual({ v0: 'a', v1: 'b' });
    expect(
      findingCounts([
        { severity: 'error', rule: 'x', params: [], pointer: '' },
        { severity: 'warning', rule: 'y', params: [], pointer: '' },
        { severity: 'warning', rule: 'y', params: [], pointer: '' },
        { severity: 'info', rule: 'z', params: [], pointer: '' },
      ]),
    ).toEqual({ errors: 1, warnings: 2, infos: 1 });
  });

  it('search paths by path, method, operation, summary or parameter', () => {
    expect(searchOutline(paths, '  ')).toEqual(paths);
    expect(searchOutline(paths, 'USERS').map((p) => p.path)).toEqual(['/users']);
    const byOperation = searchOutline(paths, 'createorder');
    expect(byOperation.map((p) => p.operations.map((o) => o.operationId))).toEqual([
      ['createOrder'],
    ]);
    expect(searchOutline(paths, 'status')[0].operations.map((o) => o.operationId)).toEqual([
      'listOrders',
    ]);
    expect(searchOutline(paths, 'list orders')).toHaveLength(1);
    expect(searchOutline(paths, 'delete')[0].path).toBe('/users');
    expect(searchOutline(paths, 'nothing')).toEqual([]);
  });
});
