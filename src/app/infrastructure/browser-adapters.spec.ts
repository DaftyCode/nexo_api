import { TestBed } from '@angular/core/testing';
import { BrowserFiles } from './browser-files';
import { BrowserPreferences } from './browser-preferences';
import { DesktopSignInWindow } from './desktop-sign-in-window';

describe('browser adapters', () => {
  const { createObjectURL, revokeObjectURL } = URL;
  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('downloads text and blobs through a temporary link, then releases it', async () => {
    vi.useFakeTimers();
    const files = new BrowserFiles();
    const created: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (blob: Blob) => (created.push(blob), `blob:${created.length}`);
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ href: this.href, download: this.download });
    });
    files.download('shop.json', '{"a":1}');
    files.download('image.png', new Blob(['png'], { type: 'image/png' }));
    expect(clicks).toEqual([
      { href: 'blob:1', download: 'shop.json' },
      { href: 'blob:2', download: 'image.png' },
    ]);
    expect(created[0].type).toBe('application/json');
    expect(await created[0].text()).toBe('{"a":1}');
    expect(created[1].type).toBe('image/png');
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(revoked).toEqual(['blob:1', 'blob:2']);
    expect(await files.read(new File(['content'], 'a.txt'))).toBe('content');
    // Larger than the chunk read at a time, and not valid UTF-8.
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 7) % 256);
    expect(await files.readBase64(new File([bytes], 'a.bin'))).toBe(
      btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
    );
    expect(files.id()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps preferences in local storage and survives a blocked storage', () => {
    TestBed.configureTestingModule({ providers: [BrowserPreferences] });
    const preferences = TestBed.inject(BrowserPreferences);
    expect(preferences.read('environment.local')).toBeUndefined();
    preferences.write('environment.local', 'dev');
    expect(localStorage.getItem('nexo.preference.environment.local')).toBe('dev');
    expect(preferences.read('environment.local')).toBe('dev');
    preferences.write('environment.local', '');
    expect(preferences.read('environment.local')).toBeUndefined();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(preferences.read('environment.local')).toBeUndefined();
    expect(() => preferences.write('environment.local', 'dev')).not.toThrow();
  });

  it('has no sign-in window outside the desktop app', async () => {
    const window = new DesktopSignInWindow();
    expect(window.available).toBe(false);
    await expect(window.close()).resolves.toBeUndefined();
  });
});
