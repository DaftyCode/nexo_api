import { collectionAuth, collectionEvents, readCollectionSettings } from './collection-settings';
import { Collection } from './models';

describe('collection settings', () => {
  const collection: Collection = {
    info: { name: 'API', schema: 's' },
    auth: {
      type: 'basic',
      basic: [
        { key: 'username', value: 'ada' },
        { key: 'password', value: 'pw' },
      ],
    },
    event: [
      { listen: 'prerequest', script: { exec: ['one', 'two'] } },
      { listen: 'custom', script: { exec: 'keep me' } },
    ],
    item: [],
  };

  it('reads auth and scripts from the collection root', () => {
    const model = readCollectionSettings(collection);
    expect(model.auth).toMatchObject({ type: 'basic', username: 'ada', password: 'pw' });
    expect(model.prerequest).toBe('one\ntwo');
    expect(model.tests).toBe('');
    expect(readCollectionSettings(undefined).auth.type).toBe('noauth');
  });

  it('writes auth in the collection format and keeps unrelated events', () => {
    const settings = readCollectionSettings(collection);
    const model = { ...settings, auth: { ...settings.auth, type: 'bearer', token: '{{token}}' } };
    expect(collectionAuth(model)).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    });
    expect(collectionAuth({ ...model, auth: { ...model.auth, type: 'noauth' } })).toBeUndefined();
    const events = collectionEvents(
      { ...model, prerequest: '', tests: 'pm.test()' },
      collection['event'],
    );
    expect(events).toEqual([
      { listen: 'custom', script: { exec: 'keep me' } },
      { listen: 'test', script: { type: 'text/javascript', exec: ['pm.test()'] } },
    ]);
    expect(collectionEvents({ ...model, prerequest: '', tests: '' }, [])).toBeUndefined();
  });

  it('keeps authorizations without dedicated fields when saved unchanged', () => {
    // Saving the collection used to drop OAuth 2 and Digest, which the form did not list.
    const oauth = {
      type: 'oauth2',
      oauth2: [
        { key: 'accessToken', value: '{{token}}', type: 'string' },
        { key: 'addTokenTo', value: 'header', type: 'string' },
        { key: 'useBrowser', value: false, type: 'boolean' },
      ],
    };
    const model = readCollectionSettings({ ...collection, auth: oauth });
    const written = collectionAuth(model) as { type: string; oauth2: { key: string }[] };
    expect(written.type).toBe('oauth2');
    expect(written.oauth2).toEqual(
      expect.arrayContaining([
        { key: 'accessToken', value: '{{token}}', type: 'string' },
        { key: 'addTokenTo', value: 'header', type: 'string' },
        { key: 'useBrowser', value: false, type: 'string' },
      ]),
    );
  });

  it('lets folders inherit or explicitly use no authorization', () => {
    const folder = { name: 'Users', item: [] };
    const inherit = readCollectionSettings(folder, true);
    expect(inherit.auth.type).toBe('inherit');
    expect(collectionAuth(inherit, true)).toBeUndefined();
    const none = { ...inherit, auth: { ...inherit.auth, type: 'noauth' } };
    expect(collectionAuth(none, true)).toMatchObject({ type: 'noauth' });
  });
});
