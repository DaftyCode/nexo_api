import {
  WriteTextError,
  changeValue,
  collectionOptions,
  dottedPath,
  duplicate,
  emptyCollectionForm,
  idFilter,
  parseDocuments,
  parseUpdate,
  parseValue,
  setField,
  unsetField,
  writeConcern,
} from './mongo-write';

const failure = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error instanceof WriteTextError ? [error.key, error.params] : (error as Error).message;
  }
  throw new Error('no error');
};

describe('MongoDB writes', () => {
  it('edits one field with $set or $unset, never the _id', () => {
    const date = { $date: { $numberLong: '1704164645006' } };
    expect(dottedPath(['items', 1, 'qty'])).toBe('items.1.qty');
    expect(setField(['customer', 'at'], date)).toEqual({ $set: { 'customer.at': date } });
    expect(unsetField(['items', 0])).toEqual({ $unset: { 'items.0': '' } });
    expect(failure(() => setField(['_id'], 1))).toBe('The _id of a document cannot change');
    expect(failure(() => setField([], 1))).toBe('Choose a field');
    expect(failure(() => unsetField(['_id', 'x']))).toBe('The _id of a document cannot change');
    const id = { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' };
    expect(idFilter({ _id: id, a: 1 })).toEqual({ _id: id });
    expect(failure(() => idFilter({ a: 1 }))).toBe('The document has no _id');
    expect(duplicate({ _id: id, a: 1 })).toEqual({ a: 1 });
  });

  it('reads typed values, documents and updates, keeping their types', () => {
    expect(parseValue("ISODate('2024-01-02T03:04:05.006Z')")).toEqual({
      $date: { $numberLong: '1704164645006' },
    });
    expect(parseValue("NumberDecimal('2.50')")).toEqual({ $numberDecimal: '2.50' });
    expect(parseDocuments('{a: 1}')).toEqual([{ a: 1 }]);
    expect(parseDocuments('[{a: 1}, {b: 2}]')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(failure(() => parseDocuments('[{a: 1}, 2]'))).toEqual(['mongo.notDocuments', {}]);
    expect(failure(() => parseDocuments('[]'))).toEqual(['mongo.notDocuments', {}]);
    expect(failure(() => parseValue('{a: '))).toEqual([
      'mongo.syntax',
      { v0: 'The text ends too soon', v1: 1, v2: 5, v3: 'expected a value' },
    ]);
    expect(parseUpdate('{$set: {a: 1}}')).toEqual({ $set: { a: 1 } });
    expect(parseUpdate('[{$set: {a: 1}}]')).toEqual([{ $set: { a: 1 } }]);
    // A document without operators would replace the whole document: refused here.
    expect(failure(() => parseUpdate('{a: 1}'))).toEqual(['mongo.notUpdate', {}]);
    expect(failure(() => parseUpdate('{}'))).toEqual(['mongo.notUpdate', {}]);
  });

  it('builds write concerns and collection options', () => {
    expect(writeConcern('')).toBeUndefined();
    expect(writeConcern('majority')).toEqual({ w: 'majority' });
    expect(writeConcern('1')).toEqual({ w: 1 });
    const form = emptyCollectionForm();
    expect(collectionOptions(form)).toEqual({});
    expect(collectionOptions({ ...form, capped: true, size: '4096', max: '10' })).toEqual({
      capped: true,
      size: 4096,
      max: 10,
    });
    expect(failure(() => collectionOptions({ ...form, capped: true, size: 'big' }))).toEqual([
      'mongo.notCount',
      {},
    ]);
    expect(
      collectionOptions({
        ...form,
        timeField: 'at',
        metaField: 'sensor',
        granularity: 'minutes',
        validator: "{$jsonSchema: {required: ['at']}}",
      }),
    ).toEqual({
      timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' },
      validator: { $jsonSchema: { required: ['at'] } },
    });
    expect(
      failure(() => collectionOptions({ ...form, capped: true, size: '1', timeField: 'at' })),
    ).toEqual(['mongo.cappedTimeSeries', {}]);
    expect(failure(() => collectionOptions({ ...form, validator: '[1]' }))).toEqual([
      'mongo.notDocument',
      {},
    ]);
  });

  it('reads recorded changes defensively', () => {
    expect(
      changeValue({ operation: 'mongo.update', matched: 1, changes: [{ before: {} }] }),
    ).toMatchObject({
      operation: 'mongo.update',
      matched: 1,
      deleted: 0,
      changes: [{ before: {} }],
    });
    expect(changeValue(null).changes).toEqual([]);
  });
});
