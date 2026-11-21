import {
  backupFileName,
  emptyNativeForm,
  formatOfFile,
  hasNativeTools,
  nativeOptions,
  nativeTimeout,
  olderThanServer,
  readNativeRun,
} from './native';

describe('the local client tools', () => {
  const form = (changes: Partial<ReturnType<typeof emptyNativeForm>>) => ({
    ...emptyNativeForm(),
    ...changes,
  });

  it('are for PostgreSQL, and MySQL and MariaDB', () => {
    expect(['postgres', 'mysql', 'sqlite', 'mssql'].map(hasNativeTools)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('back up with the options of each engine only', () => {
    const chosen = form({
      format: 'custom',
      content: 'schema',
      schemas: 'sales, , hr',
      tables: 'public.my table, orders',
      noOwner: true,
      noPrivileges: true,
      inserts: true,
      compress: '6',
    });
    expect(nativeOptions('backup', chosen, '/b.dump', 'postgres')).toEqual({
      path: '/b.dump',
      server: false,
      format: 'custom',
      content: 'schema',
      schemas: ['sales', 'hr'],
      tables: [{ schema: 'public', name: 'my table' }, 'orders'],
      noOwner: true,
      noPrivileges: true,
      inserts: true,
      compress: 6,
    });
    expect(nativeOptions('backup', chosen, '/b.sql', 'mysql')).toEqual({
      path: '/b.sql',
      server: false,
      format: 'plain',
      content: 'schema',
      schemas: [],
      tables: ['public.my table', 'orders'],
      noOwner: false,
      noPrivileges: false,
      inserts: true,
    });
    const server = nativeOptions(
      'backup',
      form({ server: true, tables: 'a', compress: '3' }),
      '/all.sql',
      'postgres',
    );
    expect(server).toMatchObject({ server: true, format: 'plain', schemas: [], tables: [] });
    expect(server).not.toHaveProperty('compress');
    expect(
      nativeOptions('backup', form({ format: 'tar', compress: '3' }), '/b.tar', 'postgres'),
    ).not.toHaveProperty('compress');
  });

  it('restore plain SQL as it was written and archives with their options', () => {
    const chosen = form({ format: 'custom', clean: true, dataOnly: true, noOwner: true });
    expect(nativeOptions('restore', chosen, '/b.dump', 'postgres')).toEqual({
      path: '/b.dump',
      format: 'custom',
      singleTransaction: true,
      clean: true,
      dataOnly: true,
      noOwner: true,
      noPrivileges: false,
    });
    expect(
      nativeOptions('restore', form({ format: 'plain', clean: true }), '/b.sql', 'postgres'),
    ).toEqual({
      path: '/b.sql',
      format: 'plain',
      singleTransaction: true,
    });
    expect(nativeOptions('restore', chosen, '/b.sql', 'mysql')).toEqual({
      path: '/b.sql',
      format: 'plain',
      singleTransaction: false,
    });
    expect(nativeOptions('script', form({ stopOnError: false }), '/s.sql', 'mysql')).toEqual({
      path: '/s.sql',
      stopOnError: false,
    });
  });

  it('read files, names, time limits, versions and runs', () => {
    expect(['a.SQL', 'b.tar', 'c.dump', 'd.backup', 'e.gz'].map(formatOfFile)).toEqual([
      'plain',
      'tar',
      'custom',
      'custom',
      'plain',
    ]);
    expect(backupFileName('my shop', 'plain')).toBe('my_shop.sql');
    expect(backupFileName('', 'directory')).toBe('backup.dump');
    expect(backupFileName('x', 'tar')).toBe('x.tar');
    expect(nativeTimeout(form({ minutes: '1.5' }))).toBe(90);
    expect(nativeTimeout(form({ minutes: ' ' }))).toBeUndefined();
    expect(nativeTimeout(form({ minutes: '-1' }))).toBeUndefined();
    expect(olderThanServer('pg_dump (PostgreSQL) 16.4', '18.1')).toBe(true);
    expect(olderThanServer('pg_dump (PostgreSQL) 18.4', '18.1')).toBe(false);
    expect(olderThanServer('mysqldump  Ver 8.4.3', undefined)).toBe(false);
    expect(olderThanServer('unknown', '18')).toBe(false);
    expect(
      readNativeRun({ tool: 'psql', state: 'running', lines: [1], dropped: 2, seconds: 3 }),
    ).toEqual({
      tool: 'psql',
      state: 'running',
      lines: ['1'],
      dropped: 2,
      exitCode: null,
      seconds: 3,
    });
    expect(readNativeRun(undefined)).toMatchObject({ tool: '', state: 'failed', lines: [] });
  });
});
