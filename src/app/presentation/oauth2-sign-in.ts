import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { WorkspaceState } from './workspace-state';
import { isReturnedAddress } from '../domain/auth';

/**
 * Dialog shown while an OAuth 2.0 sign-in waits for the browser, or for the desktop app's
 * sign-in window: it can open the sign-in page again, copy its link, take the address the
 * browser returned to (manual mode, or when the automatic return did not work; pasting it is
 * enough) and cancel.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-oauth2-sign-in',
  templateUrl: './oauth2-sign-in.html',
})
export class OAuth2SignInDialog {
  protected readonly state = inject(WorkspaceState);
  protected readonly address = signal('');
  protected readonly copied = signal(false);
  /** Shown when the returned address has no code: the token is pasted instead. */
  protected readonly needsToken = signal(false);
  protected readonly accessToken = signal('');
  protected readonly refreshToken = signal('');
  protected edit(event: Event) {
    this.address.set((event.target as HTMLInputElement).value);
  }
  /**
   * Pasting the address the browser returned to continues without pressing Continue. An
   * address without a code asks for the token instead.
   */
  protected pasted(event: ClipboardEvent) {
    const text = (event.clipboardData?.getData('text') ?? '').trim();
    if (!/^https?:\/\//i.test(text)) return;
    event.preventDefault();
    this.address.set(text);
    void this.complete();
  }
  protected value(event: Event) {
    return (event.target as HTMLInputElement).value;
  }
  protected async useToken() {
    await this.state.useOAuth2Token({
      accessToken: this.accessToken(),
      refreshToken: this.refreshToken(),
    });
  }
  protected async copy(link: string) {
    await globalThis.navigator?.clipboard?.writeText(link);
    this.copied.set(true);
  }
  protected async complete() {
    // Without a code the engine could only refuse it; ask for the token instead.
    if (!isReturnedAddress(this.address())) {
      this.needsToken.set(true);
      return;
    }
    await this.state.completeOAuth2SignIn(this.address());
    this.address.set('');
  }
}
