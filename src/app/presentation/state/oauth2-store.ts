import { signal } from '@angular/core';
import {
  AuthDraft,
  OAuth2Token,
  autoFetches,
  needsSignIn,
  oauth2UsesBrowser,
  writeAuth,
} from '../../domain/auth';
import { RequestAncestor } from '../../domain/variables';
import type { WorkspaceState } from '../workspace-state';
import { CollectionsStore } from './collections-store';
import { SignInStore } from './sign-in-store';
import { named } from './state-context';

/** Where an obtained token was kept: in the stored authorization, only in the tab, or only
 * in the vault. */
export type KeptToken = 'saved' | 'unsaved' | 'vault';

/**
 * OAuth 2.0 tokens: obtained or renewed for an authorization, kept where it is defined, and
 * the stored ones ("Available Tokens", "Manage Tokens").
 */
export class OAuth2Store {
  /** Stored OAuth 2.0 tokens: Postman's "Available Tokens". */
  readonly tokens = signal<OAuth2Token[]>([]);
  /** Whether the "Manage Tokens" dialog is open. */
  readonly managing = signal(false);
  readonly signIn: SignInStore;

  constructor(
    private readonly state: WorkspaceState,
    private readonly collections: CollectionsStore,
  ) {
    this.signIn = new SignInStore(state);
  }

  /**
   * Stores an authorization where it is defined (a request, a folder or the collection, `[]`)
   * and nothing else of that collection, such as a token just obtained.
   */
  async keepAuth(documentId: string, path: number[], auth: AuthDraft) {
    const document = this.state.collections().find((d) => d.id === documentId);
    if (!document) throw new Error('Collection not found');
    await this.collections.change(document, (tree, collection) =>
      tree.withStoredAuth(collection, path, auth),
    );
  }
  /**
   * Shows the new authorization of a request in its tab and stores it in its collection; the
   * rest of the tab's unsaved changes stay unsaved. A request outside a collection can only
   * be saved by the person.
   */
  async keepRequestAuth(tabId: string, auth: AuthDraft): Promise<KeptToken> {
    const tab = this.state.tabs().find((t) => t.id === tabId);
    if (!tab) return 'vault';
    const document = this.state.collections().find((d) => d.id === tab.documentId);
    const stored = !!document && tab.path.length > 0;
    this.state.tabsStore.tabs.update((tabs) =>
      tabs.map((t) =>
        t.id === tabId ? { ...t, request: { ...t.request, auth }, dirty: t.dirty || !stored } : t,
      ),
    );
    if (!stored) return 'unsaved';
    await this.keepAuth(document.id, tab.path, auth);
    return 'saved';
  }
  /**
   * Obtains (or with `refresh`, renews) an OAuth 2.0 token for an authorization edited in a
   * request, folder or collection, resolving variables in the scopes of `ancestors`. `keep`
   * stores it in that authorization. A toast says how it went: obtained and saved, failed, or
   * cancelled.
   */
  async token(
    auth: AuthDraft,
    ancestors: readonly RequestAncestor[],
    refresh: boolean,
    keep?: (token: OAuth2Token) => Promise<KeptToken>,
  ): Promise<OAuth2Token | undefined> {
    const state = this.state;
    let token: OAuth2Token | undefined;
    await state.guard(async () => {
      const context = {
        workspace: state.workspaceId(),
        environment: state.environmentRows(),
        globals: state.globalRows(),
        ancestors,
      };
      if (!refresh && oauth2UsesBrowser(auth)) {
        this.signIn.tokenName = String(auth.values['tokenName'] ?? '');
        token = await this.signIn.run(writeAuth(auth), context);
      } else {
        const tokenId = refresh ? String(auth.values['oauth2TokenId'] ?? '') : undefined;
        if (refresh && !tokenId) throw new Error('There is no refresh token to use');
        token = await state.cases.oauth2.oauth2Token(writeAuth(auth), context, tokenId);
      }
      if (token) {
        state.notice.set(refresh ? 'Access token refreshed' : 'Access token obtained');
        this.tokens.set(await state.cases.oauth2.oauth2Tokens(state.workspaceId()));
      }
    });
    if (!token) {
      const failure = state.error();
      if (failure) {
        // Said in the toast, not twice.
        state.error.set('');
        state.showToast({
          kind: 'error',
          title: refresh
            ? 'The access token could not be refreshed'
            : 'The access token could not be obtained',
          detail: failure,
        });
      } else {
        state.showToast({
          kind: 'info',
          title: 'Sign-in cancelled',
          message: 'No access token was obtained.',
        });
      }
      return undefined;
    }
    let kept: KeptToken = 'vault';
    if (keep) {
      try {
        kept = await keep(token);
      } catch (error) {
        state.showToast({
          kind: 'error',
          title: refresh ? 'Access token refreshed' : 'Access token obtained',
          message: 'It is in your vault, but the authorization could not be saved.',
          detail: state.describe(error),
        });
        return token;
      }
    }
    state.showToast({
      kind: 'success',
      title: refresh ? 'Access token refreshed' : 'Access token obtained',
      message: {
        saved: 'oauth2.keptSaved',
        unsaved: 'oauth2.keptUnsaved',
        vault: 'oauth2.keptVault',
      }[kept],
      params: { v0: token.name },
    });
    return token;
  }
  async loadTokens() {
    try {
      this.tokens.set(await this.state.cases.oauth2.oauth2Tokens(this.state.workspaceId()));
    } catch {
      // The list stays as it was; the editors still work with custom tokens.
    }
  }
  tokenDetails(id: string) {
    return this.state.cases.oauth2.oauth2TokenDetails(this.state.workspaceId(), id);
  }
  deleteToken(id: string) {
    const name = this.tokens().find((token) => token.id === id)?.name ?? '';
    return this.state.announce('The token could not be deleted', async () => {
      await this.state.cases.oauth2.deleteOAuth2Token(this.state.workspaceId(), id);
      this.tokens.update((tokens) => tokens.filter((token) => token.id !== id));
      return named('Token deleted', name);
    });
  }
  /**
   * Bruno's "Auto-fetch token" for grants that sign in through a browser: without a usable
   * token, the sign-in runs first and stores one under the token name, which the engine then
   * uses. Grants without a browser are fetched by the engine itself.
   */
  async signInBeforeSending() {
    const request = this.state.active()?.request;
    if (!request) return;
    const auth =
      request.auth.type === 'inherit' ? this.state.activeInheritance()?.source?.auth : request.auth;
    if (auth?.type !== 'oauth2' || !autoFetches(auth) || !oauth2UsesBrowser(auth)) return;
    await this.loadTokens();
    if (needsSignIn(auth, this.tokens(), Date.now()))
      await this.state.oauth2Token(auth, this.state.activeAncestors(), false);
  }
}
