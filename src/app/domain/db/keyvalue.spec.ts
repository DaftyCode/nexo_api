import { describe, expect, it } from 'vitest';
import {
  KvKey,
  clientList,
  databaseNumber,
  infoSections,
  isBinary,
  keyRows,
  kvText,
  parseTtl,
  replyText,
  sameKey,
  ttlText,
  typedConfirmation,
} from './keyvalue';
import { commandHints, commandSyntax } from './keyvalue/commands';

const key = (name: string, type = 'string'): KvKey => ({ key: name, type });

describe('the keys of Redis', () => {
  it('shows bytes that are not text as redis-cli escapes them', () => {
    expect(kvText('user:1')).toBe('user:1');
    expect(kvText({ $t: 'binary', v: '/wBhXA==' })).toBe('\\xff\\x00a\\x5c');
    expect(kvText({ $t: 'binary', v: '***' })).toBe('***');
    expect(kvText({ $t: 'json', v: '{}' })).toBe('{}');
    expect(kvText(null)).toBe('');
    expect(kvText(7)).toBe('7');
    expect(isBinary({ $t: 'binary', v: '' })).toBe(true);
    expect(isBinary('x')).toBe(false);
    expect(sameKey({ $t: 'binary', v: 'AA==' }, { $t: 'binary', v: 'AA==' })).toBe(true);
    expect(sameKey('a', 'b')).toBe(false);
  });

  it('groups keys by their separator, folders first, open only when expanded', () => {
    const keys = [key('user:2:name'), key('user:1:name'), key('user:1:city'), key('top'), key('a')];
    const closed = keyRows(keys, ':', new Set());
    expect(closed.map((row) => [row.label, row.count ?? '-'])).toEqual([
      ['user', 3],
      ['a', '-'],
      ['top', '-'],
    ]);
    const open = keyRows(keys, ':', new Set(['user:', 'user:1:']));
    expect(open.map((row) => `${row.depth}${row.label}`)).toEqual([
      '0user',
      '1' + '1',
      '2city',
      '2name',
      '12',
      '0a',
      '0top',
    ]);
    expect(open[2].key?.key).toBe('user:1:city');
    // Without a separator, a plain list.
    expect(keyRows(keys, '', new Set()).map((row) => row.label)).toEqual([
      'a',
      'top',
      'user:1:city',
      'user:1:name',
      'user:2:name',
    ]);
  });

  it('writes and reads expiries', () => {
    expect(ttlText(undefined)).toBe('∞');
    expect(ttlText(-1)).toBe('∞');
    expect(ttlText(45_000)).toBe('45 s');
    expect(ttlText(720_000)).toBe('12 min');
    expect(ttlText(3 * 3600_000)).toBe('3 h');
    expect(ttlText(3 * 86400_000)).toBe('3 d');
    expect(parseTtl('60')).toBe(60_000);
    expect(parseTtl('5m')).toBe(300_000);
    expect(parseTtl('2 h')).toBe(7_200_000);
    expect(parseTtl('1d')).toBe(86_400_000);
    expect(parseTtl('0')).toBeUndefined();
    expect(parseTtl('soon')).toBeUndefined();
  });

  it('writes answers as redis-cli does', () => {
    expect(replyText('OK')).toBe('"OK"');
    expect(replyText(null)).toBe('(nil)');
    expect(replyText(3)).toBe('(integer) 3');
    expect(replyText(true)).toBe('(boolean) true');
    expect(replyText([])).toBe('(empty array)');
    expect(replyText(['a', ['b', 2]])).toBe('1) "a"\n2) 1) "b"\n   2) (integer) 2');
    expect(replyText({ error: 'WRONGTYPE' })).toBe('(error) WRONGTYPE');
    expect(replyText({ $t: 'binary', v: '/w==' })).toBe('"\\xff"');
    expect(replyText({ a: 1 })).toBe('1) "a"\n2) (integer) 1');
    expect(replyText('# Server\nredis_version:7')).toContain('\n');
  });

  it('reads INFO and CLIENT LIST', () => {
    const info = infoSections(
      '# Server\r\nredis_version:7.4.1\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=0',
    );
    expect(info).toEqual([
      { name: 'Server', fields: [['redis_version', '7.4.1']] },
      { name: 'Keyspace', fields: [['db0', 'keys=3,expires=0']] },
    ]);
    expect(infoSections('loose:1')).toEqual([{ name: 'Info', fields: [['loose', '1']] }]);
    const clients = clientList('id=3 addr=127.0.0.1:5 name= cmd=client|list flag\n');
    expect(clients).toEqual([
      { id: '3', addr: '127.0.0.1:5', name: '', cmd: 'client|list', flag: '' },
    ]);
  });

  it('reads what a confirmation asks to type and the database of a tab', () => {
    expect(typedConfirmation('Type CONFIG SET to confirm it')).toBe('CONFIG SET');
    expect(typedConfirmation('read-only')).toBeUndefined();
    expect(databaseNumber('db3')).toBe(3);
    expect(databaseNumber(undefined)).toBe(0);
  });
});

describe('the commands the console completes', () => {
  it('offers the names a line starts, and the syntax of the one written', () => {
    expect(commandHints('hg').map((command) => command.name)).toEqual(['HGET', 'HGETALL']);
    expect(commandHints('  ')).toEqual([]);
    expect(commandHints('GET key ')).toEqual([]);
    expect(commandHints('client ').map((command) => command.name)).toEqual([
      'CLIENT LIST',
      'CLIENT KILL',
    ]);
    expect(commandSyntax('set k v')?.syntax).toContain('KEEPTTL');
    expect(commandSyntax('config get maxmemory')?.name).toBe('CONFIG GET');
    expect(commandSyntax('nothing')).toBeUndefined();
  });
});
