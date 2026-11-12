import { signal } from '@angular/core';
import { OAuth2SignIn, OAuth2SignInStatus } from '../../domain/auth';
import { ExecutionContext, PastedOAuth2Token } from '../../application/workspace-use-cases';
import type { WorkspaceState } from '../workspace-state';

/**
 * The OAuth 2.0 browser sign-in in progress: in the system browser, or in a window of the
 * desktop app that takes the Callback URL itself.
 */
export class SignInStore {
  /** The browser sign-in in progress, shown in a dialog until it finishes. */
  readonly current = signal<OAuth2SignIn | undefined>(undefined);
  /** Status returned by pasting the address, read by the polling loop. */
  private completed?: OAuth2SignInStatus;
  /** Token name of the sign-in in progress, for a token pasted by hand. */
  tokenName = '';

  constructor(private readonly state: WorkspaceState) {}

  /** Runs a browser sign-in until it gives a token, fails or is cancelled (`undefined`). */
  async run(auth: unknown, context: ExecutionContext) {
    const { cases } = this.state;
    const started = await cases.oauth2.oauth2Authorize(auth, context);
    // The desktop app shows the page in its own window, like Postman's built-in browser, and
    // takes the Callback URL from it. "Authorize using browser" keeps the system browser.
    const inWindow = cases.oauth2.hasSignInWindow && started.mode !== 'relay';
    this.completed = undefined;
    this.current.set({ ...started, window: inWindow, opened: started.opened || inWindow });
    if (inWindow) this.watch(started);
    else if (cases.oauth2.hasSignInWindow)
      await cases.oauth2.oauth2SignIn(this.state.workspaceId(), started.session, 'open');
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (this.current()?.session !== started.session) return undefined;
        const status =
          this.completed ??
          (await cases.oauth2.oauth2SignIn(this.state.workspaceId(), started.session, 'status'));
        this.completed = undefined;
        if (status.state === 'done') return status.token;
        if (status.state === 'error') throw new Error(status.error ?? 'The sign-in failed');
        if (status.state === 'cancelled') return undefined;
      }
    } finally {
      if (this.current()?.session === started.session) this.current.set(undefined);
      if (inWindow) void cases.oauth2.closeSignInWindow().catch(() => {});
    }
  }
  /** Takes the address from the sign-in window; closing the window cancels the sign-in. */
  private watch(signIn: OAuth2SignIn) {
    const current = () => this.current()?.session === signIn.session;
    this.state.cases.oauth2
      .openSignInWindow(signIn)
      .then(async (ended) => {
        if (!current()) return;
        if (ended.outcome === 'returned') await this.state.completeOAuth2SignIn(ended.url);
        else if (ended.outcome === 'closed') await this.state.cancelOAuth2SignIn();
      })
      .catch((error: unknown) => {
        if (current()) this.state.error.set(this.state.describe(error));
      });
  }
  /** Manual mode: the address the browser returned to. */
  async complete(url: string) {
    const signIn = this.current();
    if (!signIn) return;
    try {
      this.completed = await this.state.cases.oauth2.oauth2SignIn(
        this.state.workspaceId(),
        signIn.session,
        'complete',
        url.trim(),
      );
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  /**
   * Ends the sign-in with a token the person pasted from the browser, when the address it
   * returned to carries no code (a web front that signs in by itself and cleans its address).
   */
  async usePasted(pasted: PastedOAuth2Token) {
    const signIn = this.current();
    if (!signIn) return;
    const { cases } = this.state;
    try {
      const token = await cases.oauth2.addOAuth2Token(
        this.state.workspaceId(),
        this.tokenName,
        pasted,
      );
      this.completed = { state: 'done', token };
      void cases.oauth2
        .oauth2SignIn(this.state.workspaceId(), signIn.session, 'cancel')
        .catch(() => {});
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  async reopen() {
    const signIn = this.current();
    if (signIn?.window) this.watch(signIn);
    else if (signIn)
      await this.state.cases.oauth2.oauth2SignIn(this.state.workspaceId(), signIn.session, 'open');
  }
  async cancel() {
    const signIn = this.current();
    if (!signIn) return;
    this.current.set(undefined);
    await this.state.cases.oauth2
      .oauth2SignIn(this.state.workspaceId(), signIn.session, 'cancel')
      .catch(() => {});
  }
}
