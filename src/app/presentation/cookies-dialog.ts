import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form, submit, validate } from '@angular/forms/signals';
import {
  CookieDraft,
  CookieKey,
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
  sameCookie,
} from '../domain/cookies';
import { WorkspaceState } from './workspace-state';

/** A validation error with its message, which the template translates. */
const problem = (message: string | undefined) =>
  message ? { kind: 'cookie', message } : undefined;

/**
 * Postman's "Manage Cookies": the cookies of the workspace jar by domain, to add, edit and
 * delete them. The next request sends them as they are here.
 */
@Component({
  imports: [TranslocoPipe, DatePipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-cookies-dialog',
  styleUrl: './cookies-dialog.scss',
  templateUrl: './cookies-dialog.html',
})
export class CookiesDialog {
  protected readonly state = inject(WorkspaceState);
  protected readonly filter = signal('');
  protected readonly domains = computed(() => cookieDomains(this.state.cookies(), this.filter()));
  /** The cookie being edited, `null` for a new one, `undefined` while the form is closed. */
  protected readonly editing = signal<CookieKey | null | undefined>(undefined);
  protected readonly model = signal<CookieDraft>(emptyCookie());
  protected readonly fields = form(this.model, (p) => {
    validate(p.name, ({ value }) => problem(cookieNameError(value())));
    validate(p.value, ({ value }) => problem(cookieValueError(value())));
    validate(p.domain, ({ value }) => problem(cookieDomainError(value())));
    validate(p.path, ({ value }) => problem(cookiePathError(value())));
    validate(p.expires, ({ value }) => problem(cookieExpiresError(value(), Date.now())));
  });
  /** An IP address has no subdomains. */
  protected readonly ipDomain = computed(() => isIpAddress(this.model().domain));

  protected add(domain = '') {
    this.open(emptyCookie(domain), null);
  }
  protected edit(cookie: StoredCookie) {
    this.open(cookieDraft(cookie), cookieKey(cookie));
  }
  /** A fresh form: the errors of the last one show again only once it is touched. */
  private open(draft: CookieDraft, original: CookieKey | null) {
    this.fields().reset(draft);
    this.editing.set(original);
  }
  protected isEditing(cookie: StoredCookie) {
    const editing = this.editing();
    return !!editing && sameCookie(editing, cookieKey(cookie));
  }
  protected cancel() {
    this.editing.set(undefined);
  }
  protected save() {
    return submit(this.fields, async () => {
      const original = this.editing() ?? undefined;
      if (await this.state.saveCookie(cookieChange(this.model()), original))
        this.editing.set(undefined);
    });
  }
  protected async remove(cookie: StoredCookie) {
    if (!this.state.confirm('Delete this cookie?')) return;
    if (this.isEditing(cookie)) this.editing.set(undefined);
    await this.state.deleteCookie(cookieKey(cookie));
  }
  protected async removeDomain(domain: string) {
    if (!this.state.confirm('Delete every cookie of this domain?')) return;
    if (this.editing()?.domain === domain) this.editing.set(undefined);
    await this.state.clearCookies(domain);
  }
  protected async clear() {
    if (!this.state.confirm('Delete every cookie of this workspace?')) return;
    this.editing.set(undefined);
    await this.state.clearCookies();
  }
  protected close() {
    this.editing.set(undefined);
    this.filter.set('');
    this.state.managingCookies.set(false);
  }
  protected setFilter(event: Event) {
    this.filter.set((event.target as HTMLInputElement).value);
  }
}
