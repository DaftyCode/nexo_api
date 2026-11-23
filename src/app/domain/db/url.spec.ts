import { emptyDbForm, formOf, formProblem, formUrl, typedSecrets, valueOf, withUrl } from './form';
import { formatDbUrl, parseDbUrl } from './url';

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

  it('reads and writes MySQL and MariaDB URLs, with their ssl-mode', () => {
    const parsed = parseDbUrl(
      'jdbc:mariadb://ana:secret@db:3307/shop?ssl-mode=REQUIRED&charset=utf8mb4&useSSL=true',
    );
    expect(parsed).toEqual({
      driver: 'mysql',
      host: 'db',
      port: '3307',
      database: 'shop',
      user: 'ana',
      password: 'secret',
      tlsMode: 'require',
      params: { charset: 'utf8mb4' },
      ignored: ['useSSL'],
    });
    expect(parseDbUrl('mysql://root@localhost/?sslMode=VERIFY_IDENTITY').tlsMode).toBe('verify');
    expect(parseDbUrl('mysql://root@localhost/?ssl_mode=preferred').tlsMode).toBe('prefer');
    const form = withUrl(emptyDbForm('mysql'), parsed);
    expect(formUrl(form)).toBe('mysql://ana@db:3307/shop?ssl-mode=REQUIRED&charset=utf8mb4');
  });

  it('reads and writes SQLite URLs: the path of the file and its settings', () => {
    const parsed = parseDbUrl('jdbc:sqlite:C:/data/shop.db?journal_mode=wal&cache=shared');
    expect(parsed).toEqual({
      driver: 'sqlite',
      host: '',
      port: '',
      database: 'C:/data/shop.db',
      user: '',
      params: { journal_mode: 'wal' },
      ignored: ['cache'],
    });
    expect(parseDbUrl('sqlite:///home/ana/shop.db').database).toBe('/home/ana/shop.db');
    expect(parseDbUrl('sqlite:///C:/data/shop.db').database).toBe('C:/data/shop.db');
    expect(parseDbUrl('sqlite:{{folder}}/shop.db').database).toBe('{{folder}}/shop.db');
    const form = withUrl(emptyDbForm('sqlite'), parsed);
    expect(formUrl(form)).toBe('jdbc:sqlite:C:/data/shop.db?journal_mode=wal');
    // A file engine needs its file, not a server.
    expect(formProblem({ ...form, name: 'Shop', database: '' })).toBe('Choose the database file');
    expect(formProblem({ ...form, name: 'Shop' })).toBe('');
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

  it('reads and writes Hive JDBC URLs, their settings after the database', () => {
    const parsed = parseDbUrl(
      'jdbc:hive2://ana:pw@hive.test:10001/sales;transportMode=http;httpPath=hs2;ssl=true',
    );
    expect(parsed).toMatchObject({
      driver: 'hive',
      host: 'hive.test',
      port: '10001',
      database: 'sales',
      user: 'ana',
      password: 'pw',
      tlsMode: 'require',
    });
    expect(parsed.params).toEqual({ httpPath: 'hs2' });
    expect(parsed.ignored).toEqual(['transportMode']);
    expect(
      formatDbUrl({
        driver: 'hive',
        host: 'hive.test',
        port: '10001',
        database: 'sales',
        user: 'ana',
        tlsMode: 'require',
        params: [{ name: 'httpPath', value: 'hs2' }],
      }),
    ).toBe('hive2://ana@hive.test:10001/sales;ssl=true;httpPath=hs2');
    expect(parseDbUrl('hive://h/db').database).toBe('db');
  });

  it('reads and writes Ignite JDBC URLs, with their schema and time zone', () => {
    const parsed = parseDbUrl(
      'jdbc:ignite:thin://ignite.test:10800/SHOP?username=ana&password=pw&sslEnabled=true&timeZone=UTC&partitionAwareness=false',
    );
    expect(parsed).toMatchObject({
      driver: 'ignite',
      host: 'ignite.test',
      port: '10800',
      database: 'SHOP',
      user: 'ana',
      password: 'pw',
      tlsMode: 'require',
    });
    expect(parsed.params).toEqual({ timeZone: 'UTC' });
    expect(parsed.ignored).toEqual(['partitionAwareness']);
    expect(
      formatDbUrl({
        driver: 'ignite',
        host: 'ignite.test',
        port: '10800',
        database: 'SHOP',
        user: '',
        tlsMode: 'disable',
        params: [{ name: 'timeZone', value: 'Europe/Madrid' }],
      }),
    ).toBe('ignite://ignite.test:10800/SHOP?timeZone=Europe%2FMadrid');
    expect(parseDbUrl('ignite://h').driver).toBe('ignite');
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
