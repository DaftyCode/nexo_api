import { ApiPort } from '../ports';
import { CookieChange, CookieKey, StoredCookie } from '../../domain/cookies';

/** The cookie jar of a workspace, which requests send and fill. */
export class CookieCases {
  constructor(private readonly api: ApiPort) {}

  /** The cookies of the workspace jar that have not expired. */
  async cookies(workspace: string) {
    const { cookies } = await this.api.execute<{ cookies: StoredCookie[] }>('cookies.list', {
      workspace,
    });
    return cookies;
  }
  /** Adds a cookie, or replaces the `original` one; the next request uses it. */
  async setCookie(workspace: string, change: CookieChange, original?: CookieKey) {
    const { cookie } = await this.api.execute<{ cookie: StoredCookie }>('cookies.set', {
      workspace,
      ...change,
      ...(original ? { original } : {}),
    });
    return cookie;
  }
  deleteCookie(workspace: string, key: CookieKey) {
    return this.api.execute('cookies.delete', { workspace, ...key });
  }
  clearCookies(workspace: string) {
    return this.api.execute('cookies.clear', { workspace });
  }
}
