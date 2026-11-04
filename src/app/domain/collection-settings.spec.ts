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
    expect(model).toMatchObject({ authType: 'basic', username: 'ada', password: 'pw' });
    expect(model.prerequest).toBe('one\ntwo');
    expect(model.tests).toBe('');
    expect(readCollectionSettings(undefined).authType).toBe('noauth');
  });

  it('writes auth in the collection format and keeps unrelated events', () => {
    const model = { ...readCollectionSettings(collection), authType: 'bearer', token: '{{token}}' };
    expect(collectionAuth(model)).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    });
    expect(collectionAuth({ ...model, authType: 'noauth' })).toBeUndefined();
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
});
