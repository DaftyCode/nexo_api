import {
  emptyRoute,
  ownRoute,
  readRoute,
  routeOf,
  routeProblem,
  storedRoute,
  withRoute,
} from './route';

describe('route', () => {
  it('reads stored routes, unknown ways as direct and nothing as what it falls back to', () => {
    expect(readRoute(undefined)).toEqual(emptyRoute());
    expect(readRoute(null, 'inherit').via).toBe('inherit');
    expect(readRoute({ via: 'carrier-pigeon' }).via).toBe('direct');
    expect(readRoute('text').via).toBe('direct');
    expect(
      readRoute({ via: 'socks5', host: ' proxy ', port: 1080, password: 7, remoteDns: false }),
    ).toEqual({
      ...emptyRoute(),
      via: 'socks5',
      host: 'proxy',
      port: '1080',
      remoteDns: false,
    });
  });

  it('keeps only the fields of its way', () => {
    expect(storedRoute(emptyRoute())).toBeUndefined();
    expect(storedRoute(emptyRoute('inherit'))).toBeUndefined();
    expect(storedRoute({ ...emptyRoute(), via: 'ssh', profile: ' p1 ', host: 'x' })).toEqual({
      via: 'ssh',
      profile: 'p1',
    });
    expect(storedRoute({ ...emptyRoute(), via: 'http', host: 'proxy', password: 'pw' })).toEqual({
      via: 'http',
      host: 'proxy',
    });
    expect(
      storedRoute({
        ...emptyRoute(),
        via: 'socks5',
        host: 'proxy',
        port: ' 1081 ',
        username: 'ada',
        password: 'pw',
        remoteDns: false,
      }),
    ).toEqual({
      via: 'socks5',
      host: 'proxy',
      port: '1081',
      username: 'ada',
      password: 'pw',
      remoteDns: false,
    });
    // A proxy profile replaces the proxy written here.
    expect(storedRoute({ ...emptyRoute(), via: 'socks5', host: 'x', profile: 'office' })).toEqual({
      via: 'socks5',
      profile: 'office',
    });
    // A request or a folder keeps going directly, over the way of its parent.
    expect(ownRoute(emptyRoute())).toEqual({ via: 'direct' });
    expect(ownRoute(emptyRoute('inherit'))).toBeUndefined();
  });

  it('reads the route of transport settings and the older proxy setting', () => {
    expect(routeOf('').via).toBe('inherit');
    expect(routeOf('not json').via).toBe('inherit');
    expect(routeOf('{"route":{"via":"ssh","profile":"p1"}}')).toMatchObject({
      via: 'ssh',
      profile: 'p1',
    });
    expect(routeOf('{"proxy":{"disabled":true}}').via).toBe('direct');
    expect(
      routeOf('{"proxy":{"protocol":"http","host":"proxy","port":8080,"username":"ada"}}'),
    ).toMatchObject({ via: 'http', host: 'proxy', port: '8080', username: 'ada' });
    expect(routeOf('{"proxy":{"uri":"socks5h://[::1]:1080"}}')).toMatchObject({
      via: 'socks5',
      host: '::1',
      port: '1080',
      remoteDns: true,
    });
    expect(routeOf('{"proxy":{"uri":"no uri"}}').via).toBe('direct');
  });

  it('writes the route into transport settings and leaves the rest', () => {
    const socks = { ...emptyRoute(), via: 'socks5' as const, host: 'proxy' };
    expect(JSON.parse(withRoute('{"proxy":{"host":"old"},"caPem":"x"}', socks))).toEqual({
      caPem: 'x',
      route: { via: 'socks5', host: 'proxy', remoteDns: true },
    });
    expect(withRoute('{"route":{"via":"http","host":"p"}}', emptyRoute('inherit'))).toBe('{}');
    expect(JSON.parse(withRoute('', emptyRoute()))).toEqual({ route: { via: 'direct' } });
    expect(withRoute('[1]', socks)).toBe('[1]');
  });

  it('says what a route lacks', () => {
    expect(routeProblem(emptyRoute())).toBeUndefined();
    expect(routeProblem(emptyRoute('inherit'))).toBeUndefined();
    expect(routeProblem({ ...emptyRoute(), via: 'ssh' })).toBe(
      'Choose the SSH profile to connect through',
    );
    expect(routeProblem({ ...emptyRoute(), via: 'ssh', profile: 'p1' })).toBeUndefined();
    expect(routeProblem({ ...emptyRoute(), via: 'http' })).toBe('Enter the host of the proxy');
    expect(routeProblem({ ...emptyRoute(), via: 'http', profile: 'office' })).toBeUndefined();
    for (const port of ['0', '65536', 'x'])
      expect(routeProblem({ ...emptyRoute(), via: 'socks5', host: 'p', port })).toBe(
        'Invalid proxy port',
      );
    expect(routeProblem({ ...emptyRoute(), via: 'socks5', host: 'p', port: '1080' })).toBe(
      undefined,
    );
  });
});
