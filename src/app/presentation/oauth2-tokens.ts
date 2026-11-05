import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { OAuth2Token, OAuth2TokenDetails } from '../domain/auth';
import { WorkspaceState } from './workspace-state';

/**
 * Postman's "Manage Tokens": the stored OAuth 2.0 tokens with their expiry, their values on
 * request, and deletion. Deleting a token in Nexo does not revoke it at the provider.
 */
@Component({
  imports: [TranslocoPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-oauth2-tokens',
  styleUrl: './oauth2-tokens.scss',
  templateUrl: './oauth2-tokens.html',
})
export class OAuth2TokensDialog {
  protected readonly state = inject(WorkspaceState);
  /** The values of the token shown, loaded only when asked. */
  protected readonly shown = signal<{ id: string; details: OAuth2TokenDetails } | undefined>(
    undefined,
  );
  protected now() {
    return Date.now();
  }
  protected async show(token: OAuth2Token) {
    if (this.shown()?.id === token.id) return this.shown.set(undefined);
    try {
      this.shown.set({ id: token.id, details: await this.state.oauth2TokenDetails(token.id) });
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  protected async remove(token: OAuth2Token) {
    if (
      !this.state.confirm(
        'Delete this token? The provider is not told, so it stays valid until it expires.',
      )
    )
      return;
    if (this.shown()?.id === token.id) this.shown.set(undefined);
    await this.state.deleteOAuth2Token(token.id);
  }
  protected close() {
    this.shown.set(undefined);
    this.state.managingOAuth2Tokens.set(false);
  }
}
