import { describe, expect, it } from 'vitest';
import { emptyRoute } from '../../route';
import { emptyDbForm, formOf, formProblem, typedSecrets, valueOf } from '../form';

describe('the parts of the connection form added with DB-25', () => {
  it('keeps the route of a connection, the proxy password in the vault', () => {
    const socks = {
      ...emptyRoute('socks5'),
      host: ' proxy ',
      port: '1080',
      username: 'ana',
      password: 'typed',
    };
    const form = { ...emptyDbForm('postgres'), name: 'Shop', route: socks };
    const saved = { via: 'socks5' as const, host: 'p', username: 'ana', password: '{{vault:p}}' };
    // The saved reference stays while its user does; the typed password goes to the vault.
    expect(valueOf(form, { driver: 'postgres', route: saved }).route).toEqual({
      via: 'socks5',
      host: 'proxy',
      port: '1080',
      username: 'ana',
      password: '{{vault:p}}',
      remoteDns: true,
    });
    expect(valueOf(form).route).not.toHaveProperty('password');
    expect(typedSecrets(form)).toEqual({ proxyPassword: 'typed' });
    expect(typedSecrets({ ...form, route: { ...socks, username: '' } })).toEqual({});
    const ssh = { ...form, route: { ...emptyRoute('ssh'), profile: 'p1' } };
    expect(valueOf(ssh).route).toEqual({ via: 'ssh', profile: 'p1' });
    expect(valueOf({ ...form, route: emptyRoute() })).not.toHaveProperty('route');
    // Read back, its password is blank: blank keeps the vault's.
    expect(formOf('Shop', { driver: 'postgres', route: saved }).route).toMatchObject({
      via: 'socks5',
      host: 'p',
      password: '',
    });
    expect(formProblem({ ...form, route: { ...socks, host: '' } })).toBe(
      'Enter the host of the proxy',
    );
    expect(formProblem({ ...ssh, route: emptyRoute('ssh') })).toBe(
      'Choose the SSH profile to connect through',
    );
    expect(formProblem(form)).toBe('');
  });

  it('keeps what the sessions run as they open and how the connection is kept', () => {
    const form = {
      ...emptyDbForm('postgres'),
      name: 'Shop',
      defaultSchema: ' sales ',
      startupQueries: [{ sql: ' SET a = 1 ' }, { sql: ' ' }],
      ignoreStartupErrors: true,
      keepAliveSeconds: 60,
      idleMinutes: 5,
      connectTimeoutSeconds: 20,
    };
    const value = valueOf(form);
    expect(value).toMatchObject({
      defaultSchema: 'sales',
      startupQueries: ['SET a = 1'],
      ignoreStartupErrors: true,
      keepAliveSeconds: 60,
      idleMinutes: 5,
      connectTimeoutSeconds: 20,
    });
    expect(formOf('Shop', value)).toMatchObject({
      defaultSchema: 'sales',
      startupQueries: [{ sql: 'SET a = 1' }],
      ignoreStartupErrors: true,
      keepAliveSeconds: 60,
    });
    // The usual ones are not written; failing is allowed only with queries to fail.
    const usual = valueOf({ ...emptyDbForm('postgres'), ignoreStartupErrors: true });
    for (const key of ['startupQueries', 'ignoreStartupErrors', 'keepAliveSeconds', 'idleMinutes'])
      expect(usual).not.toHaveProperty(key);
    const problems: [Partial<typeof form>, string][] = [
      [{ keepAliveSeconds: 2 }, 'Keep alive is from 5 to 600 seconds, or 0 for none'],
      [{ idleMinutes: 11 }, 'Closing when unused is from 1 to 10 minutes, or 0 for ten'],
      [
        { connectTimeoutSeconds: 1.5 },
        'The time to connect is from 1 to 120 seconds, or 0 for the driver’s',
      ],
      [
        { startupQueries: Array.from({ length: 21 }, () => ({ sql: 'SELECT 1' })) },
        'A connection has up to 20 startup queries',
      ],
    ];
    for (const [change, problem] of problems)
      expect(formProblem({ ...form, ...change })).toBe(problem);
    expect(formProblem(form)).toBe('');
  });

  it('keeps no password for a connection that asks for it or reads pgpass', () => {
    const stored = { driver: 'postgres', password: '{{vault:db-password:c1}}' };
    const form = { ...emptyDbForm('postgres'), name: 'Shop', password: 'typed' };
    const asks = valueOf({ ...form, askPassword: true, pgpass: true }, stored);
    expect(asks).toMatchObject({ askPassword: true });
    expect(asks).not.toHaveProperty('password');
    expect(asks).not.toHaveProperty('pgpass');
    const pgpass = valueOf({ ...form, pgpass: true }, stored);
    expect(pgpass).toMatchObject({ pgpass: true });
    expect(pgpass).not.toHaveProperty('password');
    expect(valueOf(form, stored).password).toBe('{{vault:db-password:c1}}');
    expect(formOf('Shop', { driver: 'postgres', askPassword: true })).toMatchObject({
      askPassword: true,
      pgpass: false,
    });
  });
});
