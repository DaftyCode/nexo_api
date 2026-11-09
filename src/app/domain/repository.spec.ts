import { WorkspaceDocument } from './models';
import { masked } from './sanitize';
import { repositoryImport, repositoryName, restoreLocalValues, stableJson } from './repository';

const collection = (id: string, value: unknown, kind = 'collection'): WorkspaceDocument => ({
  id,
  workspace_id: 'w1',
  kind,
  name: id,
  revision: 3,
  updated_at: 1,
  value,
});

describe('repository', () => {
  it('compare documents whatever the order of their fields', () => {
    expect(stableJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      stableJson({ a: null, b: [1, { c: 2, d: 1 }] }),
    );
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
    expect(stableJson(undefined)).toBe('null');
  });

  it('keep the credentials the export masked and the local transport settings', () => {
    const local = {
      info: { name: 'Shop' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'secret' }] },
      nexoTransport: { timeout: 5 },
      item: [{ request: { auth: { basic: [{ key: 'password', value: 'p' }] } } }],
      list: ['local'],
    };
    const repository = {
      info: { name: 'Shop v2' },
      auth: {
        type: 'bearer',
        bearer: [
          { key: 'other', value: 'x' },
          { key: 'token', value: masked },
        ],
      },
      item: [{ request: { auth: { basic: [{ key: 'password', value: masked }] } } }],
      list: [masked],
      added: masked,
    };
    expect(restoreLocalValues(repository, local)).toEqual({
      info: { name: 'Shop v2' },
      auth: {
        type: 'bearer',
        bearer: [
          { key: 'other', value: 'x' },
          { key: 'token', value: 'secret' },
        ],
      },
      item: [{ request: { auth: { basic: [{ key: 'password', value: 'p' }] } } }],
      list: ['local'],
      // Nothing local to restore: it stays masked.
      added: masked,
      nexoTransport: { timeout: 5 },
    });
  });

  it('add new collections, update changed ones and leave the rest', () => {
    const documents = [
      collection('same', {
        info: { name: 'Same' },
        auth: { bearer: [{ key: 'token', value: 's' }] },
      }),
      collection('changed', { info: { name: 'Old' }, item: [] }),
      collection('env', { values: [] }, 'environment'),
      collection('local-only', { info: { name: 'Mine' } }),
    ];
    const plan = repositoryImport(
      [
        // Its export masks the token: the same as the repository, so unchanged.
        {
          id: 'same',
          value: { auth: { bearer: [{ value: masked, key: 'token' }] }, info: { name: 'Same' } },
        },
        { id: 'changed', value: { info: { name: 'New' }, item: [{ name: 'a' }] } },
        { id: 'fresh', value: { info: { name: '  ' }, item: [] } },
        { id: 'env', value: { info: { name: 'Clash' } } },
        { id: 'broken', value: 'not a collection' },
      ],
      documents,
      'w1',
    );
    expect(plan).toMatchObject({ added: 1, updated: 1, unchanged: 1, skipped: 2 });
    expect(plan.save).toEqual([
      {
        ...documents[1],
        name: 'New',
        value: { info: { name: 'New' }, item: [{ name: 'a' }] },
      },
      {
        id: 'fresh',
        workspace_id: 'w1',
        kind: 'collection',
        name: 'fresh',
        revision: 0,
        updated_at: 0,
        value: { info: { name: '  ' }, item: [] },
      },
    ]);
  });

  it('name a cloned workspace after its repository', () => {
    expect(repositoryName('https://github.com/acme/orders-api.git')).toBe('orders-api');
    expect(repositoryName('git@github.com:acme/payments.git/')).toBe('payments');
    expect(repositoryName('ssh://git@host/team/Repo.GIT')).toBe('Repo');
    expect(repositoryName('   ')).toBe('Cloned repository');
  });
});
