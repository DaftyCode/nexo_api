import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton } from '../testing/controls';
import { emptyAuth } from '../domain/auth';
import { asCollection, newRequest } from '../domain/models';
import { ToastMessage } from './toast-message';
import { TOAST_DURATION, WorkspaceState } from './workspace-state';

const token = {
  id: 'tok',
  name: 'Claims token',
  hasRefreshToken: true,
  hasIdToken: false,
  reference: 'oauth2:tok',
  idReference: 'oauth2:tok:id',
};
/** An OAuth 2.0 authorization that gets its token without a browser. */
const oauth2 = () => {
  const auth = emptyAuth('oauth2');
  return {
    ...auth,
    values: { ...auth.values, grant_type: 'client_credentials', accessTokenUrl: 'https://sso/t' },
  };
};

describe('OAuth 2.0 tokens: saved at once and told in a toast', () => {
  let fixture: ComponentFixture<ToastMessage>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const toast = () => root().querySelector<HTMLElement>('.toast');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ToastMessage],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    await state.initialize();
    fixture = TestBed.createComponent(ToastMessage);
    await fixture.whenStable();
  });
  afterEach(() => vi.useRealTimers());

  it('saves the token in the request of a collection, without saving its other edits', async () => {
    api.responses['oauth2.token'] = token;
    await state.createCollection('Claims');
    const [claims] = state.collections();
    await state.addRequest(claims);
    const item = asCollection(state.collections()[0].value).item[0];
    state.openItem(state.collections()[0], item, [0]);
    const tab = state.active()!;
    state.edit({ ...tab.request, url: 'https://unsaved.test', auth: oauth2() });
    const obtained = await state.oauth2Token(state.active()!.request.auth, [], false, (got) =>
      state.keepRequestAuth(tab.id, {
        ...state.active()!.request.auth,
        values: { ...state.active()!.request.auth.values, oauth2TokenId: got.id },
      }),
    );
    expect(obtained?.id).toBe('tok');
    const stored = asCollection(state.collections()[0].value).item[0].request as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(stored['auth'])).toContain('"tok"');
    // The URL typed but not saved stays unsaved.
    expect(stored['url']).not.toBe('https://unsaved.test');
    expect(state.active()?.dirty).toBe(true);
    expect(state.active()?.request.auth.values['oauth2TokenId']).toBe('tok');
    await fixture.whenStable();
    expect(toast()?.getAttribute('role')).toBe('status');
    expect(toast()?.textContent).toContain('Access token obtained');
    expect(toast()?.textContent).toContain(
      'Token "Claims token" saved and selected in the authorization.',
    );
  });

  it('selects the token in a request outside a collection, which the person saves', async () => {
    state.newTab({ ...newRequest('r1'), auth: oauth2() });
    const tab = state.active()!;
    expect(tab.dirty).toBe(false);
    expect(await state.keepRequestAuth(tab.id, oauth2())).toBe('unsaved');
    expect(state.active()?.dirty).toBe(true);
    expect(await state.keepRequestAuth('closed tab', oauth2())).toBe('vault');
    await expect(state.keepAuth('missing', [], oauth2())).rejects.toThrow('Collection not found');

    api.responses['oauth2.token'] = token;
    await state.oauth2Token(oauth2(), [], false, async () => 'unsaved');
    await fixture.whenStable();
    expect(toast()?.textContent).toContain('Save the request to keep using it.');
    await state.oauth2Token(oauth2(), [], false);
    await fixture.whenStable();
    expect(toast()?.textContent).toContain('Token "Claims token" kept in your vault.');
  });

  it('says when getting the token failed, was cancelled or could not be saved', async () => {
    api.responses['oauth2.token'] = () => {
      throw new Error('invalid_client: Client not found');
    };
    expect(await state.oauth2Token(oauth2(), [], false)).toBeUndefined();
    await fixture.whenStable();
    expect(toast()?.getAttribute('role')).toBe('alert');
    expect(toast()?.textContent).toContain('The access token could not be obtained');
    expect(toast()?.textContent).toContain('invalid_client: Client not found');
    // Said once, in the toast, not also in the banner.
    expect(state.error()).toBe('');

    const refresh = { ...oauth2(), values: { ...oauth2().values, oauth2TokenId: 'tok' } };
    await state.oauth2Token(refresh, [], true);
    await fixture.whenStable();
    expect(toast()?.textContent).toContain('The access token could not be refreshed');

    // The sign-in window closed: no token and no error.
    const cancelled = vi
      .spyOn(state.cases, 'oauth2Token')
      .mockResolvedValueOnce(undefined as never);
    await state.oauth2Token(oauth2(), [], false);
    cancelled.mockRestore();
    await fixture.whenStable();
    expect(toast()?.textContent).toContain('Sign-in cancelled');
    expect(toast()?.textContent).toContain('No access token was obtained.');

    api.responses['oauth2.token'] = token;
    await state.oauth2Token(refresh, [], true, async () => {
      throw new Error('Revision conflict');
    });
    await fixture.whenStable();
    expect(toast()?.getAttribute('role')).toBe('alert');
    expect(toast()?.textContent).toContain('Access token refreshed');
    expect(toast()?.textContent).toContain('the authorization could not be saved');
    expect(toast()?.textContent).toContain('Revision conflict');
  });

  it('closes by itself after 20 seconds, or with its button', async () => {
    vi.useFakeTimers();
    state.showToast({ kind: 'success', title: 'Access token obtained' });
    vi.advanceTimersByTime(TOAST_DURATION - 1);
    expect(state.toast()).toBeDefined();
    // A new toast starts its own 20 seconds.
    state.showToast({ kind: 'info', title: 'Sign-in cancelled' });
    vi.advanceTimersByTime(TOAST_DURATION - 1);
    expect(state.toast()?.title).toBe('Sign-in cancelled');
    vi.advanceTimersByTime(1);
    expect(state.toast()).toBeUndefined();
    vi.useRealTimers();

    state.showToast({ kind: 'error', title: 'The access token could not be obtained' });
    await fixture.whenStable();
    await clickButton(fixture, 'Close notification');
    expect(toast()).toBeNull();
  });
});
