import { describe, expect, it } from 'vitest';
import { emptyDbForm, formOf, formProblem, formUrl, typedSecrets, valueOf, withUrl } from './form';

describe('the connection form', () => {
  it('starts with the usual values of its engine', () => {
    const form = emptyDbForm('postgres');
    expect(form).toMatchObject({ driver: 'postgres', name: 'PostgreSQL', port: '5432' });
    expect(emptyDbForm('unknown', 'Mine')).toMatchObject({ name: 'Mine', port: '' });
  });

  it('is read from a stored connection, its secrets blank', () => {
    const form = formOf('Shop', {
      driver: 'postgres',
      host: 'db',
      port: 5433,
      database: 'shop',
      user: 'nexo',
      password: '{{vault:db-password:x}}',
      params: { search_path: 'shop' },
      tls: { mode: 'verify', caPem: 'CA', certPem: 'CERT', keyPem: '{{vault:db-key:x}}' },
      type: 'production',
      folder: 'Work',
      color: 'red',
      description: 'The shop',
      readOnly: true,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 20,
      localClient: '/opt/pg/bin',
    });
    expect(form).toMatchObject({
      name: 'Shop',
      host: 'db',
      port: '5433',
      database: 'shop',
      user: 'nexo',
      password: '',
      keyPem: '',
      tlsMode: 'verify',
      caPem: 'CA',
      certPem: 'CERT',
      params: [{ name: 'search_path', value: 'shop' }],
      type: 'production',
      folder: 'Work',
      color: 'red',
      description: 'The shop',
      readOnly: true,
      autoCommit: false,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 20,
      localClient: '/opt/pg/bin',
    });
    expect(valueOf(form).localClient).toBe('/opt/pg/bin');
    expect(valueOf({ ...form, localClient: ' ' })).not.toHaveProperty('localClient');
    expect(formOf('Empty', { driver: 'sqlite' })).toMatchObject({
      host: '',
      port: '',
      database: '',
      user: '',
      tlsMode: 'disable',
      autoCommit: true,
    });
  });

  it('is filled from a URL, whose password goes to the password field', () => {
    const form = { ...emptyDbForm('postgres'), params: [{ name: 'options', value: 'a' }] };
    const filled = withUrl(form, {
      driver: 'postgres',
      host: 'db',
      port: '',
      database: 'shop',
      user: 'nexo',
      password: 'secret',
      tlsMode: 'require',
      params: { search_path: 'shop', options: 'b' },
      ignored: [],
    });
    expect(filled).toMatchObject({
      host: 'db',
      port: '5432',
      database: 'shop',
      password: 'secret',
      tlsMode: 'require',
      url: '',
    });
    expect(filled.params).toEqual([
      { name: 'options', value: 'b' },
      { name: 'search_path', value: 'shop' },
    ]);
    const kept = withUrl(
      { ...form, password: 'old', tlsMode: 'prefer' },
      { driver: 'postgres', host: 'h', port: '1', database: '', user: '', params: {}, ignored: [] },
    );
    expect(kept).toMatchObject({ password: 'old', tlsMode: 'prefer', port: '1' });
    expect(formUrl(filled)).not.toContain('secret');
  });

  it('says what keeps it from being saved', () => {
    const form = { ...emptyDbForm('postgres'), name: 'Shop', host: 'db' };
    expect(formProblem(form)).toBe('');
    expect(formProblem({ ...form, driver: '' })).toBe('Choose the database of the connection');
    expect(formProblem({ ...form, name: ' ' })).toBe('Give the connection a name');
    expect(formProblem({ ...emptyDbForm('sqlite'), name: 'File' })).toBe(
      'Choose the database file',
    );
    expect(formProblem({ ...form, host: '', database: '' })).toBe(
      'A connection needs a server or a database',
    );
    expect(formProblem({ ...form, port: '70000' })).toBe('The port is a number from 1 to 65535');
    expect(formProblem({ ...form, port: 'abc' })).toBe('The port is a number from 1 to 65535');
    expect(formProblem({ ...form, port: '{{port}}' })).toBe('');
    expect(formProblem({ ...form, timeoutSeconds: 4000 })).toBe(
      'The statement time limit is from 1 to 3600 seconds',
    );
    expect(formProblem({ ...form, timeoutSeconds: -1 })).toBe(
      'The statement time limit is from 1 to 3600 seconds',
    );
    expect(formProblem({ ...form, params: [{ name: 'nope', value: '1' }] })).toBe(
      'Choose the driver settings from its list',
    );
    expect(
      formProblem({
        ...form,
        params: [
          { name: 'options', value: '1' },
          { name: 'options', value: '2' },
        ],
      }),
    ).toBe('Each driver setting appears once');
    expect(
      formProblem({ ...emptyDbForm('custom'), name: 'C', params: [{ name: 'any', value: '1' }] }),
    ).toBe('');
  });

  it('writes the value to store, keeping the vault references of the saved one', () => {
    const form = {
      ...emptyDbForm('postgres'),
      name: 'Shop',
      host: ' db ',
      port: '5433',
      database: 'shop',
      user: '',
      password: 'typed',
      tlsMode: 'verify' as const,
      caPem: ' CA ',
      certPem: 'CERT',
      params: [
        { name: ' search_path ', value: ' shop ' },
        { name: 'options', value: ' ' },
      ],
      type: 'production' as const,
      folder: 'Work',
      color: '',
      description: 'd',
      readOnly: true,
      autoCommit: true,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 15,
    };
    const stored = {
      driver: 'postgres',
      password: '{{vault:db-password:x}}',
      tls: { mode: 'verify' as const, keyPem: '{{vault:db-key:x}}' },
      filters: [{ path: ['shop'], include: 'a' }],
      virtualKeys: { log: ['id'] },
      virtualColumns: { t: [{ name: 'n', expression: 'e' }] },
    };
    expect(valueOf(form, stored)).toEqual({
      driver: 'postgres',
      host: 'db',
      port: 5433,
      database: 'shop',
      password: '{{vault:db-password:x}}',
      params: { search_path: 'shop' },
      tls: { mode: 'verify', caPem: 'CA', certPem: 'CERT', keyPem: '{{vault:db-key:x}}' },
      type: 'production',
      folder: 'Work',
      description: 'd',
      readOnly: true,
      autoCommit: true,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 15,
      filters: [{ path: ['shop'], include: 'a' }],
      virtualKeys: { log: ['id'] },
      virtualColumns: { t: [{ name: 'n', expression: 'e' }] },
    });
    expect(valueOf({ ...emptyDbForm('mysql'), port: '{{port}}', autoCommit: false })).toEqual({
      driver: 'mysql',
      host: 'localhost',
      port: '{{port}}',
      user: 'root',
      autoCommit: false,
    });
    expect(valueOf({ ...emptyDbForm('sqlite'), database: 'a.db', tlsMode: 'prefer' })).toEqual({
      driver: 'sqlite',
      database: 'a.db',
      tls: { mode: 'prefer' },
    });
  });

  it('keeps whether MCP agents may read it, and the columns hidden from them and the assistant', () => {
    const form = formOf('Shop', {
      driver: 'postgres',
      mcp: true,
      mcpHidden: ['users.password', ' ', 3, '*_token'],
    });
    expect(form).toMatchObject({ mcp: true, mcpHidden: 'users.password, *_token' });
    expect(valueOf(form)).toMatchObject({ mcp: true, mcpHidden: ['users.password', '*_token'] });
    expect(valueOf({ ...form, mcpHidden: ' , ' })).not.toHaveProperty('mcpHidden');
    // The assistant reads the connection it is beside: its hidden columns stay without MCP.
    const closed = valueOf({ ...form, mcp: false });
    expect(closed).not.toHaveProperty('mcp');
    expect(closed).toMatchObject({ mcpHidden: ['users.password', '*_token'] });
    expect(formOf('Old', { driver: 'postgres', mcpHidden: ['a'] })).toMatchObject({
      mcp: false,
      mcpHidden: 'a',
    });
  });

  it('gives the secrets typed, the key only with its certificate', () => {
    const form = emptyDbForm('postgres');
    expect(typedSecrets(form)).toEqual({});
    expect(typedSecrets({ ...form, password: 'p', keyPem: ' KEY ', certPem: 'CERT' })).toEqual({
      password: 'p',
      keyPem: 'KEY',
    });
    expect(typedSecrets({ ...form, keyPem: 'KEY' })).toEqual({});
  });
});
