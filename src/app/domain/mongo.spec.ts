import {
  connectionFolders,
  connectionProblem,
  connectionValue,
  emptyConnectionForm,
  formatMongoUri,
  isVaultReference,
  parseCompassExport,
  parseMongoUri,
} from './mongo';

describe('MongoDB connections', () => {
  it('reads a URI into the form and writes it back without the password', () => {
    const uri =
      'mongodb://ana%40corp:s%3Ac%2Fr@db1.test:27018,db2.test/sales?replicaSet=rs0&authSource=admin' +
      '&authMechanism=SCRAM-SHA-256&tls=true&tlsAllowInvalidCertificates=true' +
      '&readPreference=secondaryPreferred&readPreferenceTags=dc:east,rack:1&w=majority' +
      '&wtimeoutMS=500&journal=true&connectTimeoutMS=2000&socketTimeoutMS=3000' +
      '&serverSelectionTimeoutMS=4000&retryWrites=false&appName=reports&compressors=zlib';
    const { form, password } = parseMongoUri(uri);
    expect(password).toBe('s:c/r');
    expect(form).toEqual({
      ...emptyConnectionForm(),
      hosts: 'db1.test:27018\ndb2.test',
      database: 'sales',
      replicaSet: 'rs0',
      auth: 'SCRAM-SHA-256',
      username: 'ana@corp',
      authSource: 'admin',
      tls: true,
      allowInvalidCertificates: true,
      readPreference: 'secondaryPreferred',
      readPreferenceTags: 'dc:east,rack:1',
      w: 'majority',
      wtimeoutMS: '500',
      journal: true,
      connectTimeoutMS: '2000',
      socketTimeoutMS: '3000',
      serverSelectionTimeoutMS: '4000',
      retryWrites: false,
      extra: 'appName=reports&compressors=zlib',
    });
    const written = formatMongoUri(form);
    expect(written).not.toContain('s%3Ac');
    expect(written.startsWith('mongodb://ana%40corp@db1.test:27018,db2.test/sales?')).toBe(true);
    // Written again, it reads the same.
    expect(parseMongoUri(written)).toEqual({ form });
  });

  it('knows that mongodb+srv turns TLS on and keeps variables in the user name', () => {
    const { form, password } = parseMongoUri('mongodb+srv://{{user}}@cluster0.example.net/');
    expect(password).toBeUndefined();
    expect(form.srv).toBe(true);
    expect(form.tls).toBe(true);
    expect(form.auth).toBe('default');
    expect(form.username).toBe('{{user}}');
    expect(formatMongoUri(form)).toBe('mongodb+srv://{{user}}@cluster0.example.net/');
    expect(formatMongoUri({ ...form, tls: false })).toBe(
      'mongodb+srv://{{user}}@cluster0.example.net/?tls=false',
    );
    // Without authentication there is no user in the URI.
    expect(formatMongoUri({ ...form, auth: 'none' })).toBe('mongodb+srv://cluster0.example.net/');
    expect(parseMongoUri('MONGODB://h/?SSL=true&tlsInsecure=true').form).toMatchObject({
      tls: true,
      allowInvalidCertificates: true,
    });
    expect(parseMongoUri('mongodb://h/?authMechanism=PLAIN').form).toMatchObject({
      auth: 'default',
      extra: 'authMechanism=PLAIN',
    });
    expect(
      parseMongoUri('mongodb://u:{{vault:p}}@h').password,
      'a vault reference typed as the password is still taken out',
    ).toBe('{{vault:p}}');
  });

  it('explains URIs and forms that cannot work', () => {
    expect(() => parseMongoUri('postgres://h')).toThrow(/mongodb:\/\/ or mongodb\+srv/);
    expect(() => parseMongoUri('mongodb:///db')).toThrow('The URI has no host');
    const form = emptyConnectionForm();
    expect(connectionProblem(form)).toBeUndefined();
    expect(connectionProblem({ ...form, hosts: ' \n ' })).toBe('Add at least one host');
    expect(connectionProblem({ ...form, srv: true, hosts: 'a\nb' })).toMatch(/one host name/);
    expect(connectionProblem({ ...form, srv: true, hosts: 'a.example.net:27017' })).toMatch(
      /no port/,
    );
    expect(connectionProblem({ ...form, hosts: 'a\nb', directConnection: true })).toMatch(
      /one host only/,
    );
    expect(connectionProblem({ ...form, loadBalanced: true, replicaSet: 'rs0' })).toMatch(
      /load-balanced/,
    );
    expect(connectionProblem({ ...form, auth: 'SCRAM-SHA-1' })).toBe('Add the user name');
    expect(connectionProblem({ ...form, auth: 'MONGODB-X509' })).toBeUndefined();
    expect(connectionProblem({ ...form, socketTimeoutMS: '1s' })).toBe(
      'Timeouts are numbers of milliseconds',
    );
    expect(connectionProblem({ ...form, readPreferenceTags: 'dc' })).toMatch(/name:value/);
  });

  it('groups connections by folder and reads stored values defensively', () => {
    const doc = (name: string, folder?: string) => ({
      name,
      value: { uri: 'mongodb://h', folder },
    });
    const groups = connectionFolders([
      doc('b', 'Production'),
      doc('z'),
      doc('a', 'Production'),
      doc('c', 'Local'),
    ]);
    expect(groups.map((g) => [g.folder, g.connections.map((c) => c.name)])).toEqual([
      ['', ['z']],
      ['Local', ['c']],
      ['Production', ['a', 'b']],
    ]);
    expect(connectionValue(null)).toEqual({ uri: '' });
    expect(
      connectionValue({ uri: 'mongodb://h', readOnly: 'yes', color: 3, password: '{{vault:x}}' }),
    ).toEqual({ uri: 'mongodb://h', password: '{{vault:x}}' });
    expect(isVaultReference(' {{vault:mongo-password:1}} ')).toBe(true);
    expect(isVaultReference('{{vault:a}} and text')).toBe(false);
  });

  it('imports the connections MongoDB Compass exports', () => {
    const file = JSON.stringify({
      type: 'Compass Connections',
      version: { $numberInt: '1' },
      connections: [
        {
          id: '1',
          connectionOptions: { connectionString: 'mongodb+srv://ana:pw@cluster0.example.net/' },
          favorite: { name: 'Atlas', color: 'color2' },
          connectionSecrets: 'AAG…',
        },
        { id: '2', connectionOptions: { connectionString: 'mongodb://localhost:27017/' } },
        { id: '3', connectionOptions: { connectionString: 'not a uri' } },
        { id: '4' },
      ],
    });
    expect(parseCompassExport(file)).toEqual([
      {
        name: 'Atlas',
        uri: 'mongodb+srv://ana@cluster0.example.net/',
        password: 'pw',
        color: '#d4a72c',
      },
      { name: 'Connection 2', uri: 'mongodb://localhost:27017/' },
    ]);
    expect(() => parseCompassExport('{')).toThrow('The file is not JSON');
    expect(() => parseCompassExport('{"connections": []}')).toThrow(/not an export/);
  });
});
