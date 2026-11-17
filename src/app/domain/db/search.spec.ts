import { dataWhere, findInScripts } from './search';

describe('database search', () => {
  it('finds every line of the scripts and the history that holds the text', () => {
    const hits = findInScripts(
      [
        {
          kind: 'script',
          id: 's1',
          name: 'Orders',
          connection: 'c1',
          sql: 'SELECT 1;\nselect * from Orders',
        },
        { kind: 'history', id: 'h1', name: 'History', connection: 'c2', sql: 'DELETE FROM orders' },
      ],
      'orders',
      false,
    );
    expect(hits.map((hit) => [hit.id, hit.line, hit.offset])).toEqual([
      ['s1', 2, 24],
      ['h1', 1, 12],
    ]);
    expect(
      findInScripts(
        [{ kind: 'script', id: 's', name: 'n', connection: 'c', sql: 'Orders' }],
        'orders',
        true,
      ),
    ).toEqual([]);
    expect(findInScripts([], '  ', false)).toEqual([]);
  });

  it('filters the data where the value was found, its wildcards and quotes literal', () => {
    expect(
      dataWhere(['note', 'odd"name'], "it's 50%_off", {
        name: 'postgresql',
        quoteOpen: '"',
        quoteClose: '"',
      }),
    ).toBe(
      `LOWER(CAST(note AS text)) LIKE '%it''s 50!%!_off%' ESCAPE '!' OR LOWER(CAST("odd""name" AS text)) LIKE '%it''s 50!%!_off%' ESCAPE '!'`,
    );
    expect(dataWhere(['a'], 'x[1]', { name: 'tsql', quoteOpen: '[', quoteClose: ']' })).toBe(
      `LOWER(CAST(a AS nvarchar(max))) LIKE '%x![1]%' ESCAPE '!'`,
    );
  });
});
