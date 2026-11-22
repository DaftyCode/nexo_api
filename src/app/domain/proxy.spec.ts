import { describe, expect, it } from 'vitest';
import {
  emptyProxyForm,
  proxyForm,
  proxyProblem,
  proxyPort,
  proxyProfileValue,
  readProxyProfile,
} from './proxy';

describe('proxy profiles', () => {
  it('reads a profile and only a profile', () => {
    const value = { protocol: 'http', host: 'proxy', username: 'ana', secret: 'proxy-p1' };
    expect(readProxyProfile({ id: 'p1', kind: 'proxy-profile', name: 'Office', value })).toEqual({
      id: 'p1',
      name: 'Office',
      protocol: 'http',
      host: 'proxy',
      port: '',
      username: 'ana',
      remoteDns: false,
      hasPassword: true,
    });
    const socks = readProxyProfile({ id: 'p2', kind: 'proxy-profile', name: 'S' })!;
    expect(socks).toMatchObject({ protocol: 'socks5', hasPassword: false });
    expect(proxyPort(socks)).toBe('1080');
    expect(proxyPort({ ...socks, protocol: 'http' })).toBe('8080');
    expect(proxyPort({ ...socks, port: '3128' })).toBe('3128');
    expect(readProxyProfile({ id: 'x', kind: 'ssh-profile', name: 'B' })).toBeUndefined();
  });

  it('says what is missing and keeps the password only with a user', () => {
    const form = { ...emptyProxyForm(), host: 'proxy.lan', port: '1081' };
    expect(proxyProblem({ ...form, host: ' ' })).toBe('Enter the host of the proxy');
    expect(proxyProblem({ ...form, port: '70000' })).toBe('Invalid proxy port');
    expect(proxyProblem(form)).toBeUndefined();
    expect(proxyProfileValue('p1', form, true)).toEqual({
      protocol: 'socks5',
      host: 'proxy.lan',
      port: 1081,
      remoteDns: true,
    });
    const signed = { ...form, protocol: 'http' as const, port: '', username: 'ana' };
    expect(proxyProfileValue('p1', signed, true)).toEqual({
      protocol: 'http',
      host: 'proxy.lan',
      username: 'ana',
      secret: 'proxy-p1',
    });
    const read = readProxyProfile({
      id: 'p1',
      kind: 'proxy-profile',
      name: 'N',
      value: proxyProfileValue('p1', signed, true),
    })!;
    expect(proxyForm(read)).toMatchObject({ name: 'N', username: 'ana', password: '' });
  });
});
