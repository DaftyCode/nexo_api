import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { StoredCookie } from '../domain/cookies';
import { CookiesDialog } from './cookies-dialog';
import { WorkspaceState } from './workspace-state';

/** A jar that answers like the engine, so the dialog shows what it stored. */
function fakeJar(api: TestApi, initial: StoredCookie[]) {
  let jar = [...initial];
  const key = (c: { domain: unknown; path: unknown; name: unknown }) =>
    `${String(c.domain)} ${String(c.path)} ${String(c.name)}`;
  api.responses['cookies.list'] = () => ({ cookies: jar });
  api.responses['cookies.set'] = (p: Record<string, unknown>) => {
    if (p['name'] === 'refused') throw new Error('The cookie is not valid');
    const cookie: StoredCookie = {
      name: String(p['name']),
      value: String(p['value']),
      domain: String(p['domain']),
      hostOnly: !p['includeSubdomains'],
      path: String(p['path']),
      expires: (p['expires'] as number | undefined) ?? null,
      secure: !!p['secure'],
      httpOnly: !!p['httpOnly'],
      sameSite: (p['sameSite'] as string | undefined) ?? null,
    };
    const original = p['original'] as StoredCookie | undefined;
    jar = jar.filter((c) => key(c) !== key(cookie) && (!original || key(c) !== key(original)));
    jar.push(cookie);
    return { cookie };
  };
  api.responses['cookies.delete'] = (p: Record<string, unknown>) => {
    jar = jar.filter((c) => key(c) !== key(p as never));
    return { deleted: true };
  };
  api.responses['cookies.clear'] = () => {
    jar = [];
    return { cleared: true };
  };
  return () => jar;
}

const stored = (extra: Partial<StoredCookie>): StoredCookie => ({
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

describe('CookiesDialog', () => {
  let fixture: ComponentFixture<CookiesDialog>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  /** The control of the cookie form whose label starts with `label`. */
  const control = (label: string) => {
    const found = [...root().querySelectorAll('.cookie-form label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    if (!found) throw new Error(`No field ${label}`);
    return found.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  };
  const type = async (label: string, value: string) => {
    const input = control(label);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
  };
  const tick = async (label: string) => {
    (control(label) as HTMLInputElement).click();
    await fixture.whenStable();
  };
  const submit = async () => {
    (root().querySelector('.cookie-form button[type="submit"]') as HTMLButtonElement).click();
    await settle();
  };
  const sets = () => api.calls.filter((c) => c.operation === 'cookies.set').map((c) => c.payload);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [CookiesDialog],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(CookiesDialog);
    await fixture.whenStable();
  });

  it('is hidden until cookies are managed, loads the jar and says when it is empty', async () => {
    expect(root().querySelector('[role="dialog"]')).toBeNull();
    await state.manageCookies();
    await settle();
    expect(api.calls.some((c) => c.operation === 'cookies.list')).toBe(true);
    expect(root().textContent).toContain('No cookies yet.');
    expect(buttons(root(), 'Delete all cookies')).toHaveLength(0);
    await clickButton(fixture, 'Close dialog');
    expect(state.managingCookies()).toBe(false);
  });

  it('adds a cookie after checking it, and shows it under its domain', async () => {
    const jar = fakeJar(api, []);
    await state.manageCookies();
    await settle();
    await clickButton(fixture, 'Add cookie');
    expect(root().textContent).toContain('New cookie');
    await submit();
    expect(sets()).toHaveLength(0);
    expect(root().textContent).toContain('The cookie needs a name');
    expect(root().textContent).toContain('The cookie needs a domain');

    await type('Name', 'a b');
    await type('Domain', 'https://api.example.com');
    await type('Path', 'api');
    await type('Value', 'x;y');
    await type('Expires', '2000-01-01T00:00');
    await submit();
    expect(sets()).toHaveLength(0);
    for (const message of ['cannot have spaces', 'only the domain', 'starts with /', '; or line'])
      expect(root().textContent).toContain(message);
    expect(root().textContent).toContain('The expiry date has already passed');

    await type('Name', 'token');
    await type('Value', 'secret-value');
    await type('Domain', 'API.example.com');
    await type('Path', '/v1');
    await type('Expires', '2099-01-02T03:04');
    await tick('Also for subdomains');
    await tick('Secure');
    await tick('HttpOnly');
    const sameSite = control('SameSite') as HTMLSelectElement;
    sameSite.value = 'Strict';
    sameSite.dispatchEvent(new Event('input'));
    sameSite.dispatchEvent(new Event('change'));
    await submit();
    expect(sets()).toEqual([
      {
        workspace: state.workspaceId(),
        name: 'token',
        value: 'secret-value',
        domain: 'api.example.com',
        path: '/v1',
        expires: new Date('2099-01-02T03:04').getTime(),
        includeSubdomains: true,
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    expect(jar()).toHaveLength(1);
    expect(root().querySelector('.cookie-form')).toBeNull();
    expect(state.notice()).toBe('Cookie saved');
    const section = root().querySelector('[aria-label="api.example.com"]')!;
    for (const text of ['token', 'secret-value', '/v1', 'Subdomains', 'Secure', 'HttpOnly'])
      expect(section.textContent).toContain(text);
    expect(section.textContent).toContain('SameSite=Strict');

    // The next form starts untouched, without the errors of the last one.
    await clickButton(fixture, 'Add cookie');
    expect(root().querySelector('.field-error')).toBeNull();
    expect(control('Name').value).toBe('');
  });

  it('hides the subdomain option for an IP address and keeps the form when the engine refuses', async () => {
    fakeJar(api, []);
    await state.manageCookies();
    await settle();
    await clickButton(fixture, 'Add cookie');
    await type('Domain', '127.0.0.1');
    expect(root().textContent).not.toContain('Also for subdomains');
    await type('Name', 'refused');
    await submit();
    // Said in a toast, and the form stays to correct it.
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The cookie could not be saved',
      detail: 'The cookie is not valid',
    });
    expect(root().querySelector('.cookie-form')).not.toBeNull();
    await clickButton(fixture, /^\s*Cancel\s*$/);
    expect(root().querySelector('.cookie-form')).toBeNull();
  });

  it('edits a cookie in place of the original, and filters by domain or name', async () => {
    const jar = fakeJar(api, [
      stored({ name: 'session', expires: Date.now() + 3_600_000, sameSite: 'Lax' }),
      stored({ name: 'theme', domain: 'shop.test', value: 'dark' }),
    ]);
    await state.manageCookies();
    await settle();
    expect(root().textContent).toContain('Session');
    buttons(root(), /^\s*Edit\s*$/)[0].click();
    await settle();
    expect(root().textContent).toContain('Edit cookie');
    expect(control('Name').value).toBe('session');
    expect(control('SameSite').value).toBe('Lax');
    expect(root().querySelector('tr.editing')?.textContent).toContain('session');
    await type('Name', 'renamed');
    await type('Expires', '');
    await submit();
    expect(sets()[0]).toMatchObject({
      name: 'renamed',
      sameSite: 'Lax',
      original: { domain: 'api.example.com', path: '/', name: 'session' },
    });
    expect(sets()[0]).not.toHaveProperty('expires');
    expect(
      jar()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['renamed', 'theme']);
    expect(
      state
        .cookies()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['renamed', 'theme']);

    const filter = root().querySelector('input[type="search"]') as HTMLInputElement;
    filter.value = 'shop';
    filter.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root().querySelector('[aria-label="api.example.com"]')).toBeNull();
    expect(root().querySelector('[aria-label="shop.test"]')).not.toBeNull();
    filter.value = 'nothing';
    filter.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root().textContent).toContain('No cookie matches the filter.');
  });

  it('deletes a cookie, a domain and the whole jar only when confirmed', async () => {
    const jar = fakeJar(api, [
      stored({ name: 'a' }),
      stored({ name: 'b' }),
      stored({ name: 'c', domain: 'other.test' }),
      stored({ name: 'd', domain: 'third.test' }),
    ]);
    await state.manageCookies();
    await settle();
    // A domain with the cookie being edited closes the form when it is deleted.
    buttons(root(), /^\s*Edit\s*$/)[0].click();
    await settle();

    state.confirm = () => false;
    await clickButton(fixture, 'Delete cookie a');
    await clickButton(fixture, /^\s*Delete all\s*$/);
    await clickButton(fixture, 'Delete all cookies');
    await settle();
    expect(jar()).toHaveLength(4);

    state.confirm = () => true;
    await clickButton(fixture, 'Delete cookie a');
    await settle();
    expect(root().querySelector('.cookie-form')).toBeNull();
    expect(jar().map((c) => c.name)).toEqual(['b', 'c', 'd']);
    expect(state.notice()).toBe('Cookie deleted');

    buttons(root(), /^\s*Edit\s*$/)[0].click();
    await settle();
    await clickButton(fixture, /^\s*Delete all\s*$/);
    await settle();
    expect(jar().map((c) => c.name)).toEqual(['c', 'd']);
    expect(root().querySelector('.cookie-form')).toBeNull();
    expect(state.notice()).toBe('Cookies deleted');

    // Adding from a domain fills its name in.
    await clickButton(fixture, /^\s*Add\s*$/);
    expect(control('Domain').value).toBe('other.test');
    await clickButton(fixture, 'Delete all cookies');
    await settle();
    expect(jar()).toEqual([]);
    expect(state.cookies()).toEqual([]);
    expect(root().querySelector('.cookie-form')).toBeNull();
    await clickButton(fixture, /^\s*Close\s*$/);
    expect(state.managingCookies()).toBe(false);
  });
});
