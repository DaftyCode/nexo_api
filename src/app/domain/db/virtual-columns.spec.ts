import { columnsOf, evaluate, parseExpression, withVirtualColumns } from './virtual-columns';

describe('virtual columns', () => {
  const columns = [
    { name: 'price', typeName: 'decimal', kind: 'decimal' },
    { name: 'qty', typeName: 'int', kind: 'integer' },
    { name: 'label', typeName: 'text', kind: 'text' },
  ];

  it('computes each row from the others, with numbers, texts and parentheses', () => {
    const rows = [
      [{ $t: 'decimal', v: '9.99' }, 3, 'lamp'],
      [null, 2, "o'clock"],
    ];
    const shown = withVirtualColumns(columns, rows, [
      { name: 'total', expression: '(price * qty) - 1' },
      { name: 'tag', expression: "label || ' x' || qty" },
      { name: 'broken', expression: 'price +' },
    ]);
    expect(shown.columns.map((column) => column.name)).toEqual([
      'price',
      'qty',
      'label',
      'total',
      'tag',
    ]);
    expect(shown.rows[0].slice(3)).toEqual([28.97, 'lamp x3']);
    // A NULL it needs leaves it empty.
    expect(shown.rows[1].slice(3)).toEqual([null, "o'clock x2"]);
  });

  it('reads only what an expression may have, and names the columns it uses', () => {
    expect(columnsOf(parseExpression('"unit price" * -qty / 2'))).toEqual(['unit price', 'qty']);
    for (const wrong of ['alert(1)', 'a;b', 'price ** 2', "'open", '(a'])
      expect(() => parseExpression(wrong)).toThrow('db.virtual.invalid');
    expect(evaluate(parseExpression('1 / 0'), () => null)).toBeNull();
    expect(evaluate(parseExpression("'a' || 'b'"), () => null)).toBe('ab');
  });
});
