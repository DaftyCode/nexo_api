import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { OAuth2Token } from '../domain/auth';
import { OAuth2TokensDialog } from './oauth2-tokens';
import { WorkspaceState } from './workspace-state';

const token = (id: string, extra: Partial<OAuth2Token> = {}): OAuth2Token => ({
  id,
  name: `Token ${id}`,
  hasRefreshToken: false,
  hasIdToken: false,
  reference: `oauth2:${id}`,
  idReference: `oauth2:${id}:id`,
  ...extra,
});

describe('OAuth2TokensDialog', () => {
  let fixture: ComponentFixture<OAuth2TokensDialog>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [OAuth2TokensDialog],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(OAuth2TokensDialog);
    await fixture.whenStable();
  });

  it('is hidden until tokens are managed and says when there are none', async () => {
    expect(root().querySelector('[role="dialog"]')).toBeNull();
    state.managingOAuth2Tokens.set(true);
    await fixture.whenStable();
    expect(root().textContent).toContain('No tokens yet.');
    await clickButton(fixture, 'Close dialog');
    expect(state.managingOAuth2Tokens()).toBe(false);
  });

  it('shows, hides and deletes stored tokens', async () => {
    api.responses['oauth2.tokens'] = ({ action }: Record<string, unknown>) =>
      action === 'details'
        ? { accessToken: 'access-value', idToken: 'id-value', refreshToken: 'refresh-value' }
        : {};
    state.oauth2Tokens.set([
      token('a', { expiresAt: Date.now() + 60_000, hasRefreshToken: true, hasIdToken: true }),
      token('b', { expiresAt: Date.now() - 60_000 }),
      token('c'),
    ]);
    state.managingOAuth2Tokens.set(true);
    await fixture.whenStable();
    expect(root().textContent).toContain('No expiry');
    expect(root().textContent).toContain('ID token');

    buttons(root(), /^\s*Show\s*$/)[0].click();
    await settle();
    for (const value of ['access-value', 'id-value', 'refresh-value'])
      expect(root().textContent).toContain(value);
    await clickButton(fixture, /^\s*Hide\s*$/);
    expect(root().textContent).not.toContain('access-value');

    buttons(root(), /^\s*Show\s*$/)[0].click();
    await settle();
    state.confirm = () => false;
    buttons(root(), /^\s*Delete\s*$/)[0].click();
    await settle();
    expect(state.oauth2Tokens()).toHaveLength(3);
    state.confirm = () => true;
    buttons(root(), /^\s*Delete\s*$/)[0].click();
    await settle();
    expect(state.oauth2Tokens().map((t) => t.id)).toEqual(['b', 'c']);
    expect(root().textContent).not.toContain('access-value');

    api.responses['oauth2.tokens'] = () => {
      throw new Error('Token not found');
    };
    buttons(root(), /^\s*Show\s*$/)[0].click();
    await settle();
    expect(state.error()).toBe('Token not found');
    await clickButton(fixture, /^\s*Close\s*$/);
    expect(state.managingOAuth2Tokens()).toBe(false);
  });
});
