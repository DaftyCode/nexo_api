import { signal } from '@angular/core';
import { CookieChange, CookieKey, StoredCookie, cookieKey, sameCookie } from '../../domain/cookies';
import { StateContext, named, success } from './state-context';

/** The cookie jar of the workspace, for Postman's "Manage Cookies". */
export class CookiesStore {
  /** The cookies of the workspace jar. */
  readonly cookies = signal<StoredCookie[]>([]);
  /** Whether the "Manage Cookies" dialog is open. */
  readonly managing = signal(false);

  constructor(private readonly context: StateContext) {}

  /** Opens "Manage Cookies" with the cookies the jar has now. */
  manage() {
    this.managing.set(true);
    return this.load();
  }
  load() {
    const { cases, status, workspaceId } = this.context;
    return status.guard(async () => this.cookies.set(await cases.cookies.cookies(workspaceId())));
  }
  /** Saves a new or edited cookie; returns whether it was saved. */
  save(change: CookieChange, original?: CookieKey) {
    const { cases, status, workspaceId } = this.context;
    return status.announce('The cookie could not be saved', async () => {
      const cookie = await cases.cookies.setCookie(workspaceId(), change, original);
      const replaced = (other: StoredCookie) =>
        sameCookie(cookieKey(other), cookieKey(cookie)) ||
        (!!original && sameCookie(cookieKey(other), original));
      this.cookies.update((cookies) => [...cookies.filter((other) => !replaced(other)), cookie]);
      return success('Cookie saved', 'toast.cookie', { v0: cookie.name, v1: cookie.domain });
    });
  }
  delete(key: CookieKey) {
    const { cases, status, workspaceId } = this.context;
    return status.announce('The cookie could not be deleted', async () => {
      await cases.cookies.deleteCookie(workspaceId(), key);
      this.cookies.update((cookies) =>
        cookies.filter((cookie) => !sameCookie(cookieKey(cookie), key)),
      );
      return success('Cookie deleted', 'toast.cookie', { v0: key.name, v1: key.domain });
    });
  }
  /** Deletes every cookie of a domain, or of the whole jar without one. */
  clear(domain?: string) {
    const { cases, status } = this.context;
    return status.announce('The cookies could not be deleted', async () => {
      const workspace = this.context.workspaceId();
      if (domain === undefined) {
        await cases.cookies.clearCookies(workspace);
        this.cookies.set([]);
        return success('Cookies deleted');
      }
      for (const cookie of this.cookies().filter((c) => c.domain === domain))
        await cases.cookies.deleteCookie(workspace, cookieKey(cookie));
      this.cookies.update((cookies) => cookies.filter((c) => c.domain !== domain));
      return named('Cookies deleted', domain);
    });
  }
}
