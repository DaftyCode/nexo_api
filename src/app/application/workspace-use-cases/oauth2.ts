import { ApiPort, SignInWindowPort } from '../ports';
import {
  OAuth2SignIn,
  OAuth2SignInStatus,
  OAuth2Token,
  OAuth2TokenDetails,
} from '../../domain/auth';
import { toPortableRows } from '../../domain/variables';
import { ExecutionContext, PastedOAuth2Token } from './types';

/** OAuth 2.0 tokens: getting, renewing and managing them, and signing in with a browser. */
export class OAuth2Cases {
  constructor(
    private readonly api: ApiPort,
    private readonly signInWindow: SignInWindowPort,
  ) {}

  /**
   * "Get New Access Token" or, with a refresh token, its renewal for an OAuth 2.0
   * authorization. The engine resolves its variables and vault secrets as for a request.
   */
  oauth2Token(auth: unknown, context: ExecutionContext, tokenId?: string) {
    return this.api.execute<OAuth2Token>('oauth2.token', {
      ...this.authorizationPayload(auth, context),
      ...(tokenId ? { tokenId } : {}),
    });
  }
  /** Stored tokens ("Available Tokens") without their values. */
  async oauth2Tokens(workspace: string) {
    const { tokens } = await this.api.execute<{ tokens: OAuth2Token[] }>('oauth2.tokens', {
      workspace,
      action: 'list',
    });
    return tokens;
  }
  /** Every value of a stored token, for "Manage Tokens". */
  oauth2TokenDetails(workspace: string, id: string) {
    return this.api.execute<OAuth2TokenDetails>('oauth2.tokens', {
      workspace,
      action: 'details',
      id,
    });
  }
  /**
   * Keeps a token the person pasted, when a sign-in cannot take one by itself (in the web
   * version, a Callback URL that another application consumes). It is stored like an obtained
   * token, so it can be selected and renewed with its refresh token.
   */
  addOAuth2Token(workspace: string, name: string, token: PastedOAuth2Token) {
    return this.api.execute<OAuth2Token>('oauth2.tokens', {
      workspace,
      action: 'add',
      name,
      accessToken: token.accessToken,
      ...(token.refreshToken?.trim() ? { refreshToken: token.refreshToken } : {}),
      ...(token.idToken?.trim() ? { idToken: token.idToken } : {}),
    });
  }
  deleteOAuth2Token(workspace: string, id: string) {
    return this.api.execute('oauth2.tokens', { workspace, action: 'delete', id });
  }
  /**
   * Starts a browser sign-in (authorization code, PKCE or implicit). With a sign-in window
   * (desktop) the system browser is not opened: the window shows the page instead.
   */
  oauth2Authorize(auth: unknown, context: ExecutionContext) {
    return this.api.execute<OAuth2SignIn>('oauth2.authorize', {
      ...this.authorizationPayload(auth, context),
      action: 'start',
      openBrowser: !this.signInWindow.available,
    });
  }
  /** Whether sign-ins can use a window of the app instead of the system browser. */
  get hasSignInWindow() {
    return this.signInWindow.available;
  }
  /** Shows a sign-in page in the app's window until it reaches the Callback URL. */
  openSignInWindow(signIn: OAuth2SignIn) {
    return this.signInWindow.open(signIn.authorizationUrl, signIn.redirectUri);
  }
  closeSignInWindow() {
    return this.signInWindow.close();
  }
  /** `status`, `open` (the browser again), `complete` (with the returned address) or `cancel`. */
  oauth2SignIn(
    workspace: string,
    session: string,
    action: 'status' | 'open' | 'complete' | 'cancel',
    url?: string,
  ) {
    return this.api.execute<OAuth2SignInStatus>('oauth2.authorize', {
      workspace,
      session,
      action,
      ...(url ? { url } : {}),
    });
  }
  /** The authorization and the scopes its variables are resolved in. */
  private authorizationPayload(auth: unknown, context: ExecutionContext) {
    return {
      ...(context.workspace ? { workspace: context.workspace } : {}),
      request: {
        name: 'OAuth 2.0',
        request: { method: 'GET', url: 'https://oauth2.invalid/', auth },
      },
      variables: toPortableRows(context.environment),
      globals: toPortableRows(context.globals),
      context: { ancestors: context.ancestors },
    };
  }
}
