import {
  applyScriptValues,
  emptyVariable,
  inheritedCollectionVariables,
  previewText,
  referencedVariables,
  requestAncestors,
  requestVariables,
  resolveVariable,
  scopeValues,
  toCollectionVariables,
  toPortableRows,
  toVariableRows,
} from './variables';
import { newRequest, Collection } from './models';

const scopes = {
  environment: [emptyVariable('host', 'https://dev.example.test'), emptyVariable('shared', 'env')],
  collection: [emptyVariable('shared', 'collection'), emptyVariable('version', 'v1')],
  globals: [emptyVariable('shared', 'global'), emptyVariable('tenant', 'acme')],
};

describe('variables domain', () => {
  it('normalizes portable rows and keeps secret markers', () => {
    const rows = toVariableRows([
      { key: 'a', value: 1, enabled: true },
      { key: 'b', value: 'x', disabled: true, type: 'secret' },
      { value: 'missing key' },
    ]);
    expect(rows).toEqual([
      { key: 'a', value: '1', enabled: true, secret: false },
      { key: 'b', value: 'x', enabled: false, secret: true },
    ]);
    expect(toPortableRows([...rows, emptyVariable()])).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'x', enabled: false, type: 'secret' },
    ]);
    expect(toCollectionVariables(rows)).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'x', disabled: true, type: 'secret' },
    ]);
  });

  it('resolves with environment, collection and global precedence', () => {
    expect(resolveVariable('shared', scopes)).toMatchObject({ scope: 'environment', value: 'env' });
    expect(resolveVariable('version', scopes)).toMatchObject({ scope: 'collection', value: 'v1' });
    expect(resolveVariable('tenant', scopes)).toMatchObject({ scope: 'globals', value: 'acme' });
    expect(resolveVariable('$guid', scopes)).toMatchObject({ defined: true, scope: 'dynamic' });
    expect(resolveVariable('vault:token', scopes)).toMatchObject({ scope: 'vault', secret: true });
    expect(resolveVariable('missing', scopes).defined).toBe(false);
    const disabled = {
      ...scopes,
      environment: [{ ...emptyVariable('shared', 'off'), enabled: false }],
    };
    expect(resolveVariable('shared', disabled).scope).toBe('collection');
  });

  it('finds variables used by the enabled parts of a request', () => {
    const request = newRequest('r');
    request.url = '{{host}}/{{ version }}/users';
    request.headers = [
      { key: 'X-Tenant', value: '{{tenant}}', enabled: true },
      { key: 'X-Off', value: '{{ignored}}', enabled: false },
    ];
    request.body = '{"id":"{{userId}}"}';
    request.auth.type = 'bearer';
    request.auth.token = '{{token}}';
    expect(requestVariables(request).sort()).toEqual(
      ['host', 'tenant', 'token', 'userId', 'version'].sort(),
    );
    expect(referencedVariables({ a: ['{{x}}', { b: '{{y}}' }] })).toEqual(['x', 'y']);
  });

  it('previews text without exposing secrets', () => {
    const secret = { ...scopes, environment: [{ ...emptyVariable('token', 'abc'), secret: true }] };
    expect(previewText('{{host}}/x', scopes)).toBe('https://dev.example.test/x');
    expect(previewText('Bearer {{token}}', secret)).toBe('Bearer ••••••');
    expect(previewText('{{unknown}}', scopes)).toBe('{{unknown}}');
  });

  it('applies script changes, adds new keys, disables unset keys and ignores redactions', () => {
    const rows = [
      emptyVariable('keep', '1'),
      emptyVariable('change', 'old'),
      emptyVariable('gone', 'x'),
    ];
    const next = applyScriptValues(rows, {
      keep: '1',
      change: 'new',
      added: 5,
      secret: 'Bearer [REDACTED]',
    });
    expect(next).toEqual([
      emptyVariable('keep', '1'),
      emptyVariable('change', 'new'),
      { ...emptyVariable('gone', 'x'), enabled: false },
      emptyVariable('added', '5'),
    ]);
    expect(applyScriptValues(rows, { keep: '1', change: 'old', gone: 'x' })).toBeUndefined();
    expect(applyScriptValues(rows, undefined)).toBeUndefined();
  });

  it('reads engine scopes in both shapes', () => {
    expect(scopeValues({ values: [{ key: 'a', value: '1' }] })).toEqual({ a: '1' });
    expect(scopeValues([{ key: 'b', value: '2' }])).toEqual({ b: '2' });
    expect(scopeValues(undefined)).toBeUndefined();
  });

  it('collects the collection and folders above a request', () => {
    const collection: Collection = {
      info: { name: 'API', schema: 's' },
      variable: [{ key: 'root', value: '1' }],
      auth: { type: 'bearer' },
      item: [
        {
          name: 'Folder',
          variable: [{ key: 'folder', value: '2' }],
          item: [{ name: 'Leaf', request: { url: 'x' } }],
        },
      ],
    };
    const ancestors = requestAncestors(collection, [0, 0]);
    expect(ancestors.map((a) => a.name)).toEqual(['API', 'Folder']);
    expect(ancestors[0].auth).toEqual({ type: 'bearer' });
    expect(inheritedCollectionVariables(ancestors).map((row) => row.key)).toEqual([
      'root',
      'folder',
    ]);
    expect(requestAncestors(collection, [1]).length).toBe(1);
  });
});
