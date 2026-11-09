import {
  StoredCookie,
  cookieChange,
  cookieDomainError,
  cookieDomains,
  cookieDraft,
  cookieExpiresError,
  cookieKey,
  cookieNameError,
  cookiePathError,
  cookieValueError,
  emptyCookie,
  isIpAddress,
  localDateTime,
  sameCookie,
} from './cookies';

const cookie = (extra: Partial<StoredCookie> = {}): StoredCookie => ({
  name: 'session',
  value: 'abc',
  domain: 'api.example.com',
  hostOnly: true,
  path: '/',
  expires: null,
  secure: false,
  httpOnly: false,
  sameSite: null,
  ...extra,
});

describe('cookies', () => {
  it('group the cookies by domain, sorted, and filter them by domain or name', () => {
    const cookies = [
      cookie({ domain: 'b.test', name: 'z' }),
      cookie({ domain: 'a.test', name: 'y', path: '/v2' }),
      cookie({ domain: 'a.test', name: 'x', path: '/v2' }),
      cookie({ domain: 'a.test', name: 'w', path: '/' }),
    ];
    const grouped = cookieDomains(cookies);
    expect(grouped.map((d) => d.domain)).toEqual(['a.test', 'b.test']);
    expect(grouped[0].cookies.map((c) => c.name)).toEqual(['w', 'x', 'y']);
    expect(cookieDomains(cookies, ' B.TEST ').map((d) => d.domain)).toEqual(['b.test']);
    expect(cookieDomains(cookies, 'x')[0].cookies.map((c) => c.name)).toEqual(['x']);
    expect(cookieDomains(cookies, 'nothing')).toEqual([]);
  });

  it('turn a stored cookie into a draft and a draft into the change the engine gets', () => {
    const expires = new Date(2030, 0, 2, 3, 4).getTime();
    const draft = cookieDraft(
      cookie({ hostOnly: false, expires, secure: true, httpOnly: true, sameSite: 'Lax' }),
    );
    expect(draft).toEqual({
      name: 'session',
      value: 'abc',
      domain: 'api.example.com',
      path: '/',
      expires: '2030-01-02T03:04',
      includeSubdomains: true,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(cookieChange(draft)).toEqual({
      name: 'session',
      value: 'abc',
      domain: 'api.example.com',
      path: '/',
      expires,
      includeSubdomains: true,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(cookieDraft(cookie({ sameSite: 'weird' })).sameSite).toBe('');
    expect(
      cookieChange({
        ...emptyCookie(' .Example.COM '),
        name: ' a ',
        value: ' b ',
        path: ' ',
      }),
    ).toEqual({ name: 'a', value: 'b', domain: 'example.com', path: '/' });
    // An IP address has no subdomains.
    expect(
      cookieChange({ ...emptyCookie('127.0.0.1'), includeSubdomains: true }),
    ).not.toHaveProperty('includeSubdomains');
    expect(localDateTime(new Date(2031, 10, 9, 8, 7).getTime())).toBe('2031-11-09T08:07');
  });

  it('identify cookies by domain, path and name', () => {
    expect(cookieKey(cookie())).toEqual({ domain: 'api.example.com', path: '/', name: 'session' });
    expect(sameCookie(cookieKey(cookie()), cookieKey(cookie({ value: 'other' })))).toBe(true);
    expect(sameCookie(cookieKey(cookie()), cookieKey(cookie({ path: '/v2' })))).toBe(false);
  });

  it('check names, values, domains, paths and expiry as the engine does', () => {
    expect(cookieNameError('session_id')).toBeUndefined();
    expect(cookieNameError(' ')).toBe('The cookie needs a name');
    for (const name of ['a b', 'a=b', 'a;b', 'a"b', 'ñ'])
      expect(cookieNameError(name)).toMatch(/cannot have/);
    expect(cookieValueError('a b=c')).toBeUndefined();
    expect(cookieValueError('a;b')).toMatch(/cannot have/);
    expect(cookieValueError('a\nb')).toMatch(/cannot have/);
    for (const domain of ['api.example.com', '.example.com', 'localhost', '127.0.0.1', '[::1]'])
      expect(cookieDomainError(domain)).toBeUndefined();
    expect(cookieDomainError('')).toBe('The cookie needs a domain');
    for (const domain of ['https://a.com', 'a.com/x', 'a.com:80', 'u@a.com', 'a b.com'])
      expect(cookieDomainError(domain)).toMatch(/only the domain/);
    expect(cookiePathError('')).toBeUndefined();
    expect(cookiePathError('/api')).toBeUndefined();
    expect(cookiePathError('api')).toMatch(/starts with/);
    expect(cookiePathError('/a b')).toMatch(/starts with/);
    const now = new Date(2030, 0, 1).getTime();
    expect(cookieExpiresError('', now)).toBeUndefined();
    expect(cookieExpiresError('2030-01-02T00:00', now)).toBeUndefined();
    expect(cookieExpiresError('2029-12-31T00:00', now)).toBe('The expiry date has already passed');
    expect(cookieExpiresError('not a date', now)).toBe('Choose a valid date');
    expect(isIpAddress('10.0.0.1')).toBe(true);
    expect(isIpAddress('[::1]')).toBe(true);
    expect(isIpAddress('example.com')).toBe(false);
  });
});
