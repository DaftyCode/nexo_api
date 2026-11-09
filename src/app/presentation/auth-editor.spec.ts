import { ComponentFixture, TestBed } from '@angular/core/testing';
import { emptyAuth, readAuth, writeAuth } from '../domain/auth';
import { buttons, clickButton, exerciseControls } from '../testing/controls';
import { testProviders } from '../testing/providers';
import { AuthEditor } from './auth-editor';
import { WorkspaceState } from './workspace-state';

const types = [
  'noauth',
  'bearer',
  'basic',
  'apikey',
  'digest',
  'oauth1',
  'oauth2',
  'jwt',
  'asap',
  'awsv4',
  'ntlm',
  'edgegrid',
  'wsse',
  'netrc',
  'hawk',
];
const grants = [
  'authorization_code',
  'authorization_code_with_pkce',
  'implicit',
  'password_credentials',
  'client_credentials',
];
const selectWith = (root: HTMLElement, value: string) =>
  [...root.querySelectorAll('select')].find((select) =>
    [...select.options].some((option) => option.value === value),
  )!;

describe('AuthEditor', () => {
  let fixture: ComponentFixture<AuthEditor>;
  const input = (label: string) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('label')]
      .find((element) => element.textContent?.trim().startsWith(label))
      ?.querySelector('input') as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AuthEditor],
    }).compileComponents();
    fixture = TestBed.createComponent(AuthEditor);
  });

  it('shows Bruno key names and saves them under the Postman names', async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'awsv4',
        awsv4: [
          { key: 'accessKeyId', value: 'AKID' },
          { key: 'secretAccessKey', value: 'secret' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Access Key').value).toBe('AKID');
    expect(input('Secret Key').value).toBe('secret');

    input('Access Key').value = 'AKID2';
    input('Access Key').dispatchEvent(new Event('input'));
    const saved = writeAuth(fixture.componentInstance.auth()) as {
      awsv4: { key: string; value: unknown }[];
    };
    expect(saved.awsv4).toContainEqual({ key: 'accessKey', value: 'AKID2', type: 'string' });
    expect(saved.awsv4.map((row) => row.key)).not.toContain('accessKeyId');
    expect(saved.awsv4.map((row) => row.key)).toContain('secretAccessKey');
  });

  it("keeps Insomnia's empty Bearer prefix", async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'bearer',
        bearer: [
          { key: 'token', value: 't' },
          { key: 'prefix', value: '' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Prefix').value).toBe('');
  });

  it('shows Insomnia ASAP names and saves them under the Postman names', async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'asap',
        asap: [
          { key: 'issuer', value: 'insomnia-issuer' },
          { key: 'keyId', value: 'key-1' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Issuer').value).toBe('insomnia-issuer');
    expect(input('Key ID').value).toBe('key-1');
    input('Issuer').value = 'nexo';
    input('Issuer').dispatchEvent(new Event('input'));
    const saved = writeAuth(fixture.componentInstance.auth()) as {
      asap: { key: string; value: unknown }[];
    };
    expect(saved.asap).toContainEqual({ key: 'iss', value: 'nexo', type: 'string' });
    expect(saved.asap.map((row) => row.key)).not.toContain('issuer');
  });

  // Every control of every type or grant: slower than a single interaction.
  it('stores every field of every authorization type', async () => {
    for (const type of types) {
      fixture.componentRef.setInput('auth', emptyAuth(type));
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const typeSelect = selectWith(root, 'hawk');
      const unchanged = await exerciseControls(fixture, () => fixture.componentInstance.auth(), {
        skip: (control) =>
          control === typeSelect || control === selectWith(root, 'authorization_code'),
      });
      expect(unchanged, type).toEqual([]);
      expect(fixture.componentInstance.auth().type).toBe(type);
    }
  }, 30_000);

  // Every control of every type or grant: slower than a single interaction.
  it('stores every OAuth 2.0 field of every grant type and asks for tokens', async () => {
    const requested: boolean[] = [];
    fixture.componentInstance.tokenRequested.subscribe((refresh) => requested.push(refresh));
    for (const grant of grants) {
      fixture.componentRef.setInput(
        'auth',
        readAuth({
          type: 'oauth2',
          oauth2: [
            { key: 'grant_type', value: grant },
            { key: 'useBrowser', value: true },
            { key: 'autoFetchToken', value: true },
            { key: 'addTokenTo', value: 'queryParams' },
          ],
        }),
      );
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      for (const add of buttons(root, /^\+?\s*Add/)) add.click();
      await fixture.whenStable();
      const typeSelect = selectWith(root, 'hawk');
      const grantSelect = selectWith(root, 'implicit');
      const unchanged = await exerciseControls(fixture, () => fixture.componentInstance.auth(), {
        skip: (control) => control === typeSelect || control === grantSelect,
      });
      // The token list only selects stored tokens, and there are none.
      expect(
        unchanged.filter((name) => !name.startsWith('select')),
        grant,
      ).toEqual([]);
      for (const remove of buttons(root, /Remove/)) remove.click();
      await fixture.whenStable();
    }
    await clickButton(fixture, 'Get new access token');
    expect(requested).toContain(false);
  }, 30_000);

  it('uses, refreshes and reveals a stored OAuth 2.0 token', async () => {
    const state = TestBed.inject(WorkspaceState);
    const requested: boolean[] = [];
    fixture.componentInstance.tokenRequested.subscribe((refresh) => requested.push(refresh));
    fixture.componentRef.setInput(
      'auth',
      readAuth({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }] }),
    );
    await fixture.whenStable();
    state.oauth2Tokens.set([
      {
        id: 'stored',
        name: 'Stored',
        expiresAt: Date.now() + 60_000,
        obtainedAt: Date.now(),
        hasRefreshToken: true,
        hasIdToken: true,
        reference: 'oauth2:stored',
        idReference: 'oauth2:stored:id',
      },
    ]);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const tokens = selectWith(root, 'stored');
    tokens.value = 'stored';
    tokens.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    await clickButton(fixture, 'Refresh');
    expect(requested).toEqual([true]);
    const source = selectWith(root, 'id_token');
    source.value = 'id_token';
    source.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(fixture.componentInstance.auth().values['tokenSource']).toBe('id_token');
    for (const reveal of buttons(root, /Show|Hide/)) reveal.click();
    await fixture.whenStable();
    await clickButton(fixture, 'Manage Tokens');
    expect(state.managingOAuth2Tokens()).toBe(true);
    tokens.value = '';
    tokens.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(selectWith(root, 'stored').value).toBe('');
  });

  it('explains what an inherited authorization sends and links to it', async () => {
    let edits = 0;
    fixture.componentInstance.editInherited.subscribe(() => edits++);
    fixture.componentRef.setInput('inheritable', true);
    fixture.componentRef.setInput('auth', readAuth(undefined));
    const root = fixture.nativeElement as HTMLElement;

    await fixture.whenStable();
    expect(root.textContent).toContain('Save the request in a collection');

    fixture.componentRef.setInput('inheritance', {});
    await fixture.whenStable();
    expect(root.textContent).toContain('No folder or collection above');
    await clickButton(fixture, 'Set an authorization for the collection');

    const sources = [
      {
        name: 'API',
        path: [],
        auth: readAuth({ type: 'bearer', bearer: [{ key: 'token', value: 't' }] }),
      },
      {
        name: 'Users',
        path: [0],
        auth: readAuth({
          type: 'basic',
          basic: [
            { key: 'username', value: 'ana' },
            { key: 'password', value: 'p' },
          ],
        }),
      },
      { name: 'Legacy', path: [0], auth: readAuth({ type: 'custom-tool' }) },
    ];
    for (const source of sources) {
      fixture.componentRef.setInput('inheritance', { source });
      await fixture.whenStable();
      expect(root.textContent).toContain(source.name);
      await clickButton(fixture, 'Edit authorization');
    }
    expect(root.textContent).toContain('custom-tool');
    expect(edits).toBe(4);
  });

  it('keeps and shows a stored type it does not know', async () => {
    fixture.componentRef.setInput('auth', readAuth({ type: 'kerberos' }));
    await fixture.whenStable();
    const select = selectWith(fixture.nativeElement as HTMLElement, 'hawk');
    expect(select.value).toBe('kerberos');
    expect(writeAuth(fixture.componentInstance.auth())?.['type']).toBe('kerberos');
  });
});
