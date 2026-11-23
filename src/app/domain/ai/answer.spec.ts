import { answerParts, codeActions, mongoQueryOf } from './answer';

describe('the code of an answer', () => {
  it('cuts an answer at its fenced blocks, one still being written included', () => {
    expect(
      answerParts('Count them:\n```SQL\nSELECT count(*)\nFROM orders;\n```\nThat is all.\n'),
    ).toEqual([
      { kind: 'text', text: 'Count them:' },
      { kind: 'code', language: 'sql', code: 'SELECT count(*)\nFROM orders;' },
      { kind: 'text', text: 'That is all.' },
    ]);
    expect(answerParts('```\n{ "a": 1 }\n```')).toEqual([
      { kind: 'code', language: '', code: '{ "a": 1 }' },
    ]);
    expect(answerParts('Writing\n```js\npm.test(')).toEqual([
      { kind: 'text', text: 'Writing' },
      { kind: 'code', language: 'js', code: 'pm.test(' },
    ]);
    expect(answerParts('')).toEqual([]);
  });

  it('offers what a block can become in each place', () => {
    expect(codeActions('request', 'javascript')).toEqual(['tests']);
    expect(codeActions('request', 'json')).toEqual([]);
    expect(codeActions('sql', 'sql')).toEqual(['open', 'run']);
    expect(codeActions('sql', '')).toEqual(['open', 'run']);
    expect(codeActions('sql', 'python')).toEqual([]);
    expect(codeActions('mongo', 'json')).toEqual(['use', 'run']);
    expect(codeActions('mongo', 'sql')).toEqual([]);
  });

  it('reads a MongoDB filter or pipeline, unwrapping shell calls', () => {
    expect(mongoQueryOf('{ "status": "paid" }')).toEqual({
      kind: 'filter',
      text: '{ "status": "paid" }',
    });
    expect(mongoQueryOf('[{ "$match": {} }]')).toEqual({
      kind: 'pipeline',
      text: '[{ "$match": {} }]',
    });
    expect(mongoQueryOf('db.orders.find({ total: { $gt: 5 } });')).toEqual({
      kind: 'filter',
      text: '{ total: { $gt: 5 } }',
    });
    expect(mongoQueryOf('db.orders.aggregate([{ $count: "n" }])').kind).toBe('pipeline');
  });
});
