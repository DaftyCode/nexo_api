import { emptyDbForm, formOf, formProblem, formUrl, typedSecrets, valueOf, withUrl } from './form';
import { parseDbUrl } from './url';

describe('database URLs', () => {
  it('reads a PostgreSQL URL into the form and takes its password out', () => {
    const parsed = parseDbUrl(
      'postgresql://ana:s%40cret@db.example.com:6543/shop?sslmode=verify-full&application_name=nexo&channel_binding=require',
    );
    expect(parsed).toEqual({
      driver: 'postgres',
      host: 'db.example.com',
      port: '6543',
      database: 'shop',
      user: 'ana',
      password: 's@cret',
      tlsMode: 'verify',
      params: { application_name: 'nexo' },
      ignored: ['channel_binding'],
    });
    const form = withUrl(emptyDbForm('postgres'), parsed);
    expect(form.password).toBe('s@cret');
    expect(formUrl(form)).toBe(
      'postgresql://ana@db.example.com:6543/shop?sslmode=verify-full&application_name=nexo',
    );
  });

  it('accepts the JDBC prefix, the short scheme, IPv6 and variables', () => {
    expect(parseDbUrl('jdbc:postgres://[::1]:5432/db').host).toBe('[::1]');
    const parsed = parseDbUrl('postgres://{{user}}@{{host}}:{{port}}/{{db}}?sslmode=require');
    expect(parsed).toEqual(
      expect.objectContaining({
        user: '{{user}}',
        host: '{{host}}',
        port: '{{port}}',
        database: '{{db}}',
        tlsMode: 'require',
      }),
    );
    expect(parsed.password).toBeUndefined();
    const form = withUrl(emptyDbForm('postgres'), parsed);
    expect(formUrl(form)).toBe('postgresql://{{user}}@{{host}}:{{port}}/{{db}}?sslmode=require');
  });

  it('reads the parameters PostgreSQL also takes in the query', () => {
    const parsed = parseDbUrl('postgresql:///shop?host=localhost&port=5433&user=bob&password=x');
    expect(parsed).toEqual(
      expect.objectContaining({ host: 'localhost', port: '5433', user: 'bob', password: 'x' }),
    );
  });

  it('refuses what is not a URL of a known engine', () => {
    expect(() => parseDbUrl('localhost:5432')).toThrow(/Paste a URL/);
    expect(() => parseDbUrl('oracle://host/db')).toThrow(/no module/);
    expect(parseDbUrl('mysql://root@host/db', ['mysql']).driver).toBe('mysql');
  });
});

describe('the connection form', () => {
  it('writes a value without secrets, and reads it back', () => {
    const form = {
      ...emptyDbForm('postgres'),
      name: 'Shop',
      host: 'db',
      port: '5433',
      password: 'typed',
      tlsMode: 'verify' as const,
      certPem: 'CERT',
      keyPem: 'KEY',
      params: [{ name: 'search_path', value: 'shop' }],
      type: 'production' as const,
      autoCommit: false,
      folder: 'Live',
    };
    const value = valueOf(form);
    expect(value).toEqual({
      driver: 'postgres',
      host: 'db',
      port: 5433,
      database: 'postgres',
      user: 'postgres',
      params: { search_path: 'shop' },
      tls: { mode: 'verify', certPem: 'CERT' },
      type: 'production',
      folder: 'Live',
    });
    expect(typedSecrets(form)).toEqual({ password: 'typed', keyPem: 'KEY' });
    const read = formOf('Shop', { ...value, password: '{{vault:db-password:1}}' });
    expect(read).toEqual(expect.objectContaining({ port: '5433', autoCommit: false }));
    expect(read.password).toBe('');
    // The stored references are kept when nothing new is typed.
    const stored = { ...value, password: '{{vault:db-password:1}}' };
    expect(valueOf(read, stored).password).toBe('{{vault:db-password:1}}');
  });

  it('says what keeps it from being saved', () => {
    const form = emptyDbForm('postgres');
    expect(formProblem(form)).toBe('');
    expect(formProblem({ ...form, port: '70000' })).toMatch(/port/);
    expect(formProblem({ ...form, port: '{{port}}' })).toBe('');
    expect(formProblem({ ...form, name: ' ' })).toMatch(/name/);
    expect(formProblem({ ...form, host: '', database: '' })).toMatch(/server/);
    expect(formProblem({ ...form, params: [{ name: 'sslkey', value: 'x' }] })).toMatch(/list/);
  });
});
