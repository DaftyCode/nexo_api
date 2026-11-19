import { vi } from 'vitest';
import { BrowserNotifications } from './browser-notifications';

/** A stand-in for the web `Notification` API, with what it showed. */
function fakeNotification(permission: NotificationPermission, answer = permission) {
  const shown: { title: string; body?: string }[] = [];
  const api = Object.assign(
    function (this: unknown, title: string, options?: { body?: string }) {
      shown.push({ title, body: options?.body });
    },
    {
      permission,
      requestPermission: vi.fn(async () => answer),
    },
  );
  vi.stubGlobal('Notification', api);
  return { api, shown };
}

describe('BrowserNotifications', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks once and shows notifications only when allowed', async () => {
    const { api, shown } = fakeNotification('default', 'granted');
    const notifications = new BrowserNotifications();
    expect(notifications.permission()).toBe('default');
    notifications.show('Not yet', '');
    expect(shown).toEqual([]);
    expect(await notifications.request()).toBe('granted');
    expect(api.requestPermission).toHaveBeenCalledOnce();
    api.permission = 'granted';
    expect(await notifications.request()).toBe('granted');
    expect(api.requestPermission).toHaveBeenCalledOnce();
    notifications.show('Monitor «Nightly» failed', '1 assertion failed');
    expect(shown).toEqual([{ title: 'Monitor «Nightly» failed', body: '1 assertion failed' }]);
  });

  it('says when the browser refuses them or has none', async () => {
    fakeNotification('denied');
    expect(await new BrowserNotifications().request()).toBe('denied');
    vi.stubGlobal('Notification', undefined);
    const none = new BrowserNotifications();
    expect(none.permission()).toBe('unsupported');
    expect(await none.request()).toBe('unsupported');
    expect(() => none.show('a', 'b')).not.toThrow();
  });
});
