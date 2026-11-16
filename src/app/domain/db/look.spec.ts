import { columnBadge, compactCount, detailRows, nodeIcon, partIcon } from './look';

describe('how the database section draws what drivers describe', () => {
  it('gives each node an icon by its class, and each folder by what it holds', () => {
    expect(nodeIcon({ kind: 'table', name: 'orders' })).toBe('table');
    expect(nodeIcon({ kind: 'schema', name: 'public' })).toBe('cube');
    expect(nodeIcon({ kind: 'folder', name: 'tables' })).toBe('folder');
    expect(nodeIcon({ kind: 'folder', name: 'foreign-keys' })).toBe('link');
    expect(nodeIcon({ kind: 'folder', name: 'policies' })).toBe('policy');
    expect(nodeIcon({ kind: 'mystery', name: 'x' })).toBe('datasets');
    expect(partIcon('data')).toBe('table');
    expect(partIcon('properties')).toBe('info');
    expect(partIcon('ddl')).toBe('code');
    expect(partIcon('indexes')).toBe('bars');
    expect(partIcon('something-new')).toBe('rule');
  });

  it('heads a column by its key, by what its name says or by its class', () => {
    expect(columnBadge({ name: 'id', kind: 'uuid', key: true })).toEqual({ icon: 'key' });
    expect(columnBadge({ name: 'email', kind: 'text' })).toEqual({ icon: 'mail' });
    expect(columnBadge({ name: 'user_mail', kind: 'text' })).toEqual({ icon: 'mail' });
    expect(columnBadge({ name: 'password', kind: 'text' })).toEqual({ icon: 'lock' });
    expect(columnBadge({ name: 'name', kind: 'text' })).toEqual({ glyph: 'Aa' });
    expect(columnBadge({ name: 'total', kind: 'decimal' })).toEqual({ glyph: '#' });
    expect(columnBadge({ name: 'paid', kind: 'boolean' })).toEqual({ icon: 'toggle' });
    expect(columnBadge({ name: 'day', kind: 'timestamptz' })).toEqual({ icon: 'calendar' });
    expect(columnBadge({ name: 'doc', kind: 'json' })).toEqual({ icon: 'body' });
    expect(columnBadge({ name: 'picture', kind: 'binary' })).toEqual({ icon: 'binary' });
    expect(columnBadge({ name: 'ref', kind: 'uuid' })).toEqual({ glyph: 'ID' });
  });

  it('writes counts short and reads the rows a driver estimates', () => {
    expect([0, 950, 1234, 24_000, 199_600, 1_500_000, 3e9].map(compactCount)).toEqual([
      '0',
      '950',
      '1.2K',
      '24K',
      '200K',
      '1.5M',
      '3G',
    ]);
    expect(detailRows('~200000 rows')).toBe(200000);
    expect(detailRows('12 rows')).toBe(12);
    expect(detailRows('partitioned')).toBeUndefined();
    expect(detailRows(undefined)).toBeUndefined();
  });
});
