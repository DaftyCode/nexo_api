import { WatchPipelineError, WatchSettings, watchLabel, watchOptions } from './mongo-watch';

const settings: WatchSettings = {
  database: 'shop',
  collection: '{{coll}}',
  pipeline: "[{$match: {operationType: 'insert'}}]",
  fullDocument: 'updateLookup',
  fullDocumentBeforeChange: 'off',
  resumeAfter: '',
};

const failure = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof WatchPipelineError) return [error.key, error.params];
    throw error;
  }
  return undefined;
};

describe('MongoDB change streams', () => {
  it('reads what is watched, its pipeline and options', () => {
    expect(watchOptions(settings, (text) => text.replace('{{coll}}', 'orders'))).toEqual({
      database: 'shop',
      collection: 'orders',
      pipeline: [{ $match: { operationType: 'insert' } }],
      fullDocument: 'updateLookup',
    });
    expect(
      watchOptions({
        ...settings,
        database: '',
        collection: '',
        pipeline: ' ',
        fullDocument: 'default',
        fullDocumentBeforeChange: 'whenAvailable',
        resumeAfter: ' 8263 ',
      }),
    ).toEqual({ pipeline: [], fullDocumentBeforeChange: 'whenAvailable', resumeAfter: '8263' });
  });

  it('says why a pipeline cannot be used', () => {
    expect(failure(() => watchOptions({ ...settings, pipeline: '{$match: {}}' }))).toEqual([
      'mongo.watch.pipeline',
      {},
    ]);
    expect(failure(() => watchOptions({ ...settings, pipeline: '[1]' }))?.[0]).toBe(
      'mongo.watch.pipeline',
    );
    expect(failure(() => watchOptions({ ...settings, pipeline: '[{a: }]' }))?.[0]).toBe(
      'mongo.watch.syntax',
    );
    expect(failure(() => watchOptions({ ...settings, database: '' }))).toEqual([
      'mongo.watch.database',
      {},
    ]);
  });

  it('names what is watched', () => {
    expect(watchLabel({ database: 'shop', collection: 'orders' })).toBe('shop.orders');
    expect(watchLabel({ database: 'shop', collection: '' })).toBe('shop');
    expect(watchLabel({ database: '', collection: '' })).toBe('deployment');
  });
});
