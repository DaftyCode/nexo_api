import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, fill, valueOf } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { newRequest } from '../domain/models';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('IntegrationPanel', () => {
  let fixture: ComponentFixture<IntegrationPanel>;

  let api: TestApi;

  let state: WorkspaceState;

  const root = () => fixture.nativeElement as HTMLElement;

  // Inputs, selects and code editors alike.
  const field = (label: string) => ({ value: valueOf(root(), label) });

  const type = (label: string, value: string) => fill(fixture, label, value);

  const settle = async () => {
    for (let i = 0; i < 3; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await fixture.whenStable();
  });

  it('saves, edits and removes vault secrets with their allowed domains', async () => {
    await clickButton(fixture, 'vault');
    await settle();
    expect(root().textContent).toContain('No secrets saved yet.');
    await type('Secret name', 'api_token');
    await clickButton(fixture, 'Save secret');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The secret could not be saved',
      detail: 'Enter the secret value',
    });

    await type('Value', 's3cret');
    await type('Allowed domains', 'api.example.com');
    await clickButton(fixture, 'Save secret');
    await settle();
    expect(api.secretNames).toEqual(['api_token']);
    expect(root().textContent).toContain('{{vault:api_token}}');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Secret saved',
      message: 'toast.secretSaved',
      params: { v0: '{{vault:api_token}}' },
    });

    await clickButton(fixture, 'Edit');
    expect(field('Secret name').value).toBe('api_token');
    const [remove] = buttons(root(), /^\s*Remove\s*$/);
    remove.click();
    await settle();
    expect(api.secretNames).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Secret removed', params: { v0: 'api_token' } });
    await type('Secret name', '');
    await clickButton(fixture, 'Remove secret');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The secret could not be removed',
      detail: 'Enter a secret name',
    });
  });

  it('exchanges an OAuth token and uses it in the active request', async () => {
    api.responses['oauth.token'] = {
      status: 200,
      body: { access_token: 'abcdefghijklmnopqrstuvwxyz', token_type: 'Bearer', expires_in: 60 },
    };
    await clickButton(fixture, 'oauth');
    await clickButton(fixture, 'Get token and use in request');
    await settle();
    expect(root().textContent).toContain('Enter the full token endpoint URL');

    state.newTab(newRequest('r1'));
    await type('Token endpoint', 'https://auth.example.com/token');
    await type('Grant type', 'authorization_code');
    for (const [label, value] of [
      ['Client ID', 'client'],
      ['Client secret', 'secret'],
      ['Scope', 'read'],
      ['Authorization code', 'code-1'],
      ['Redirect URI', 'http://localhost/cb'],
      ['PKCE code verifier', 'verifier'],
    ])
      await type(label, value);
    await clickButton(fixture, 'Get token and use in request');
    await settle();
    expect(api.calls.at(-1)?.payload['fields']).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'http://localhost/cb',
      code_verifier: 'verifier',
    });
    expect(root().textContent).toContain('abcdef…wxyz');
    expect(state.active()?.request.auth).toMatchObject({
      type: 'bearer',
      token: 'abcdefghijklmnopqrstuvwxyz',
    });
  });
});
