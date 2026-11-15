import { emptyDbForm, formUrl, withUrl } from '../form';
import { parseDbUrl } from '../url';

describe('SQL Server URLs', () => {
  it('reads a JDBC URL into the form and takes its password out', () => {
    const parsed = parseDbUrl(
      'jdbc:sqlserver://db.example.com\\SALES:1444;databaseName=shop;user=ana;password=s3cret;' +
        'encrypt=true;trustServerCertificate=true;applicationName=Reports;loginTimeout=30',
    );
    expect(parsed).toEqual({
      driver: 'mssql',
      host: 'db.example.com',
      port: '1444',
      database: 'shop',
      user: 'ana',
      password: 's3cret',
      tlsMode: 'require',
      params: { instance: 'SALES', application_name: 'Reports' },
      ignored: ['loginTimeout'],
    });
    const form = withUrl(emptyDbForm('mssql'), parsed);
    expect(form.password).toBe('s3cret');
    expect(formUrl(form)).toBe(
      'jdbc:sqlserver://db.example.com\\SALES:1444;databaseName=shop;user=ana;' +
        'encrypt=true;trustServerCertificate=true;applicationName=Reports',
    );
  });

  it('checks the certificate unless it is trusted, and reads strict and plain logins', () => {
    expect(parseDbUrl('sqlserver://host;encrypt=true').tlsMode).toBe('verify');
    expect(parseDbUrl('sqlserver://host;encrypt=false').tlsMode).toBe('disable');
    const strict = parseDbUrl('sqlserver://host:1433;encrypt=strict');
    expect([strict.tlsMode, strict.params['strict']]).toEqual(['verify', 'true']);
    expect(parseDbUrl('sqlserver://host').tlsMode).toBeUndefined();
    const form = withUrl(emptyDbForm('mssql'), strict);
    expect(formUrl(form)).toBe('jdbc:sqlserver://host:1433;encrypt=strict');
  });

  it('reads the URLs of Go and the other clients, with variables', () => {
    const parsed = parseDbUrl(
      'sqlserver://bob:p%40ss@{{host}}:{{port}}/SALES?database={{db}}&encrypt=disable',
    );
    expect(parsed).toEqual(
      expect.objectContaining({
        driver: 'mssql',
        host: '{{host}}',
        port: '{{port}}',
        user: 'bob',
        password: 'p@ss',
        database: '{{db}}',
        tlsMode: 'disable',
        params: { instance: 'SALES' },
      }),
    );
    expect(parseDbUrl('mssql://sa@localhost/?database=shop&encrypt=no').tlsMode).toBe('disable');
  });
});
