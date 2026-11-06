import { TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { WORKSPACE } from '../composition/providers';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { ApiPort, FilePort, SignInWindowOutcome, SignInWindowPort } from '../application/ports';
import { readAuth } from '../domain/auth';
import { WorkspaceState } from './workspace-state';
import { OAuth2SignInDialog } from './oauth2-sign-in';

const token = { id: 't1', name: 'SSO', reference: '{{vault:nexo-oauth2:t1}}' };
const auth = readAuth({
  type: 'oauth2',
  oauth2: [
    { key: 'grant_type', value: 'authorization_code_with_pkce' },
    { key: 'authUrl', value: 'https://login.test/authorize' },
    { key: 'accessTokenUrl', value: 'https://login.test/token' },
    { key: 'redirect_uri', value: 'https://front.example.com/callback' },
    { key: 'clientId', value: 'app' },
  ],
});

/** A workspace whose engine answers sign-ins, with a desktop sign-in window that ends as given. */
function setup(ending: SignInWindowOutcome, mode = 'manual') {
  const executed: { operation: string; payload: Record<string, unknown> }[] = [];
  const api = {
    async workspaces() {
      return [{ id: 'local', name: 'Local' }];
    },
    async documents() {
      return [];
    },
    async execute<T>(operation: string, payload: Record<string, unknown>) {
      executed.push({ operation, payload });
      if (operation === 'oauth2.tokens') return { tokens: [token] } as T;
      const answers: Record<string, unknown> = {
        start: {
          session: 's1',
          authorizationUrl: 'https://login.test/authorize?client_id=app',
          mode,
          redirectUri: 'https://front.example.com/callback',
          opened: false,
        },
        complete: { state: 'done', token },
        cancel: { state: 'cancelled' },
        open: { opened: true },
        status: { state: 'waiting' },
      };
      return answers[String(payload['action'])] as T;
    },
  } as unknown as ApiPort;
  const files: FilePort = { id: () => 'id', read: async () => '', download() {} };
  const opened: string[][] = [];
  let closed = 0;
  const signInWindow: SignInWindowPort = {
    available: true,
    async open(url, callbackUrl) {
      opened.push([url, callbackUrl]);
      return ending;
    },
    async close() {
      closed++;
    },
  };
  const cases = new WorkspaceUseCases(api, files, undefined, signInWindow);
  TestBed.configureTestingModule({
    providers: [...testProviders(), { provide: WORKSPACE, useValue: cases }],
  });
  return { state: TestBed.inject(WorkspaceState), executed, opened, closed: () => closed };
}
const actions = (executed: { operation: string; payload: Record<string, unknown> }[]) =>
  executed.filter((call) => call.operation === 'oauth2.authorize').map((c) => c.payload['action']);

describe('OAuth 2.0 sign-in window of the desktop app', () => {
  it('takes the token from the Callback URL the window reached, without the system browser', async () => {
    const { state, executed, opened, closed } = setup({
      outcome: 'returned',
      url: 'https://front.example.com/callback?code=c1&state=x',
    });
    const obtained = await state.oauth2Token(auth, [], false);
    expect(obtained?.id).toBe('t1');
    const start = executed.find((call) => call.payload['action'] === 'start');
    expect(start?.payload['openBrowser']).toBe(false);
    expect(opened).toEqual([
      ['https://login.test/authorize?client_id=app', 'https://front.example.com/callback'],
    ]);
    const complete = executed.find((call) => call.payload['action'] === 'complete');
    expect(complete?.payload['url']).toBe('https://front.example.com/callback?code=c1&state=x');
    expect(state.oauth2SignIn()).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('cancels the sign-in when the window is closed', async () => {
    const { state, executed } = setup({ outcome: 'closed' });
    expect(await state.oauth2Token(auth, [], false)).toBeUndefined();
    expect(actions(executed)).toContain('cancel');
    expect(actions(executed)).not.toContain('complete');
  });

  it('keeps the system browser for "Authorize using browser"', async () => {
    const { state, executed, opened } = setup({ outcome: 'closed' }, 'relay');
    const signingIn = state.oauth2Token(auth, [], false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toEqual([]);
    expect(actions(executed)).toEqual(['start', 'open']);
    expect(state.oauth2SignIn()?.window).toBe(false);
    await state.cancelOAuth2SignIn();
    expect(await signingIn).toBeUndefined();
  });
});

describe('OAuth 2.0 sign-in dialog', () => {
  async function dialog() {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [OAuth2SignInDialog],
    }).compileComponents();
    const state = TestBed.inject(WorkspaceState);
    state.oauth2SignIn.set({
      session: 's1',
      authorizationUrl: 'https://login.test/authorize',
      mode: 'manual',
      redirectUri: 'https://front.example.com/callback',
      opened: true,
    });
    const completed: string[] = [];
    state.completeOAuth2SignIn = async (url) => void completed.push(url);
    const fixture = TestBed.createComponent(OAuth2SignInDialog);
    await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    const paste = (text: string) => {
      const event = new Event('paste', { cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      input.dispatchEvent(event);
      return event;
    };
    return { completed, paste };
  }

  it('continues by itself when the returned address is pasted', async () => {
    const { completed, paste } = await dialog();
    const event = paste(' https://front.example.com/callback?code=c1&state=x ');
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(true);
    expect(completed).toEqual(['https://front.example.com/callback?code=c1&state=x']);
  });

  it('leaves other pasted text to be edited', async () => {
    const { completed, paste } = await dialog();
    expect(paste('https://front.example.com/callback').defaultPrevented).toBe(false);
    expect(completed).toEqual([]);
  });
});
