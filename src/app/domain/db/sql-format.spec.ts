import { formatSql, meaning } from './sql-format';

const long = `select o.id, o.total, c.email, (select count(*) from shop.items i where i."order" = o.id) as items
from shop.orders o left join shop.customers c on c.id = o.customer -- the buyer
where o.status = 'paid' and o.total > 10.5 or (o.note like '%x;y%' and o.id::text <> '7')
group by o.id, o.total, c.email having count(*) > 1 order by o.total desc, o.id limit 20;
update shop.orders set status = 'sent', note = null where id in (1, 2, 3);
insert into shop.items (name, "order") values ('a', 1), ('b', 2);
delete from shop.items where name like 'a%' /* gone */ and "order" = 1;`;

describe('formatting SQL', () => {
  it('lays a statement out by clauses without changing its tokens', () => {
    const formatted = formatSql(long);
    expect(meaning(formatted)).toEqual(meaning(long));
    expect(formatted.split('\n').length).toBeGreaterThan(15);
    expect(formatted).toContain('SELECT\n  o.id,\n  o.total,');
    expect(formatted).toContain('\nLEFT JOIN shop.customers c ON c.id = o.customer -- the buyer');
    expect(formatted).toContain(
      "\n  AND o.total > 10.5\n  OR (o.note LIKE '%x;y%' AND o.id::text <> '7')",
    );
    // A subquery starts on a line of its own.
    expect(formatted).toMatch(/\(\n\s+SELECT/);
  });

  it('gives the same text when formatted twice, and keeps the case it is told', () => {
    const once = formatSql(long);
    expect(formatSql(once)).toBe(once);
    const lower = formatSql('SELECT A FROM T', {
      keywords: 'lower',
      indent: '\t',
      commaFirst: true,
    });
    expect(lower).toBe('select\n\tA\nfrom T');
    const first = formatSql('select a, b from t', {
      keywords: 'upper',
      indent: '  ',
      commaFirst: true,
    });
    expect(first).toBe('SELECT\n  a\n, b\nFROM t');
  });
});
