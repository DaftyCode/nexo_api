import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { WorkspaceState } from './workspace-state';

/**
 * Dialog shown while an OAuth 2.0 sign-in waits for the browser: it can open the sign-in page
 * again, copy its link, take the address the browser returned to (manual mode, or when the
 * automatic return did not work) and cancel.
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
  protected edit(event: Event) {
    this.address.set((event.target as HTMLInputElement).value);
  }
  protected async copy(link: string) {
    await globalThis.navigator?.clipboard?.writeText(link);
    this.copied.set(true);
  }
  protected async complete() {
    await this.state.completeOAuth2SignIn(this.address());
    this.address.set('');
  }
}
