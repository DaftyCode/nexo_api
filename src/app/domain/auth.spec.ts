import {
  autoRefreshes,
  selectedToken,
  withCustomToken,
  authDetails,
  emptyAuth,
  inheritedAuth,
  isReturnedAddress,
  oauth2Grant,
  oauth2Shows,
  oauth2UsesBrowser,
  needsSignIn,
  OAuth2Token,
  readAuth,
  withAuthValue,
  withOAuth2Token,
  writeAuth,
} from './auth';
import { Collection } from './models';

const bearer = (token: string) => ({ type: 'bearer', bearer: [{ key: 'token', value: token }] });

describe('authorization', () => {
  it('reads a missing authorization as inherited and writes it back as none stored', () => {
    expect(readAuth(undefined).type).toBe('inherit');
    expect(readAuth(undefined, 'noauth').type).toBe('noauth');
    expect(writeAuth(emptyAuth('inherit'))).toBeUndefined();
  });

  it('ignores stored keys that would replace the type or the editor state', () => {
    const auth = readAuth({
      type: 'bearer',
      bearer: [
        { key: 'token', value: 'abc' },
        { key: 'type', value: 'basic' },
        { key: 'values', value: 'x' },
      ],
    });
    expect(auth.type).toBe('bearer');
    expect(auth.token).toBe('abc');
    expect(writeAuth(auth)).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: 'abc', type: 'string' }],
    });
  });

  it('finds the nearest folder or collection that sets an authorization', () => {
    const collection: Collection = {
      info: { name: 'API', schema: 's' },
      auth: bearer('root'),
      item: [
        {
          name: 'Local',
          auth: bearer('local'),
          item: [{ name: 'Nested', item: [{ name: 'Request', request: {} }] }],
        },
        { name: 'Plain', item: [{ name: 'Request', request: {} }] },
        { name: 'Top request', request: {} },
      ],
    };
    const nested = inheritedAuth(collection, [0, 0, 0]);
    expect(nested?.name).toBe('Local');
    expect(nested?.path).toEqual([0]);
    expect(nested?.auth.token).toBe('local');
    expect(inheritedAuth(collection, [1, 0])?.path).toEqual([]);
    expect(inheritedAuth(collection, [2])?.name).toBe('API');
    // A folder inherits from above itself, never from its own authorization.
    expect(inheritedAuth(collection, [0])?.name).toBe('API');
    expect(inheritedAuth({ ...collection, auth: undefined }, [1, 0])).toBeUndefined();
  });

  it('shows the OAuth 2.0 fields of each grant type, as Postman', () => {
    const oauth = (grant?: string) =>
      readAuth({ type: 'oauth2', oauth2: grant ? [{ key: 'grant_type', value: grant }] : [] });
    expect(oauth2Grant(oauth())).toBe('authorization_code');
    expect(oauth2Grant(oauth('password'))).toBe('password_credentials');
    expect(oauth2Shows(oauth('client_credentials'), 'authUrl')).toBe(false);
    expect(oauth2Shows(oauth('client_credentials'), 'accessTokenUrl')).toBe(true);
    expect(oauth2Shows(oauth('implicit'), 'clientSecret')).toBe(false);
    expect(oauth2Shows(oauth('authorization_code'), 'code_verifier')).toBe(false);
    expect(oauth2Shows(oauth('authorization_code_with_pkce'), 'code_verifier')).toBe(true);
    expect(oauth2Shows(oauth('password_credentials'), 'username')).toBe(true);
    expect(oauth2UsesBrowser(oauth('implicit'))).toBe(true);
    expect(oauth2UsesBrowser(oauth('client_credentials'))).toBe(false);
  });

  it('keeps edited values and their JSON in step and stores obtained tokens', () => {
    let auth = withAuthValue(readAuth({ type: 'oauth2', oauth2: [] }), 'clientId', 'app');
    auth = withAuthValue(auth, 'tokenRequestParams', [
      { key: 'a', value: 'b', send_as: 'request_url' },
    ]);
    expect(JSON.parse(auth.parameters)).toEqual(auth.values);
    // Saving uses the edited values, not a stale JSON copy.
    expect(writeAuth(auth)).toMatchObject({
      oauth2: expect.arrayContaining([{ key: 'clientId', value: 'app', type: 'string' }]),
    });
  });

  it('keeps other tools options and the edited username over stale JSON', () => {
    const basic = withAuthValue(
      readAuth({ type: 'basic', basic: [{ key: 'username', value: 'u' }] }),
      'useISO88591',
      true,
    );
    expect(writeAuth(basic)).toMatchObject({
      basic: expect.arrayContaining([{ key: 'useISO88591', value: true, type: 'string' }]),
    });
    const bearer = withAuthValue(readAuth({ type: 'bearer', bearer: [] }), 'prefix', 'JWT');
    expect(writeAuth(bearer)).toMatchObject({
      bearer: expect.arrayContaining([{ key: 'prefix', value: 'JWT', type: 'string' }]),
    });
    // Digest: the password typed in its field is saved, not the copy in the JSON.
    const digest = readAuth({
      type: 'digest',
      digest: [
        { key: 'username', value: 'u' },
        { key: 'password', value: 'old' },
        { key: 'algorithm', value: 'SHA-256' },
      ],
    });
    const saved = writeAuth({ ...digest, password: 'new' }) as {
      digest: { key: string; value: unknown }[];
    };
    expect(saved.digest.find((row) => row.key === 'password')?.value).toBe('new');
    expect(saved.digest.find((row) => row.key === 'algorithm')?.value).toBe('SHA-256');
  });

  it('uses stored tokens by reference, never by value', () => {
    const token = {
      id: 't1',
      name: 'GOOD',
      tokenType: 'Bearer',
      hasRefreshToken: true,
      hasIdToken: true,
      reference: '{{vault:nexo-oauth2:t1}}',
      idReference: '{{vault:nexo-oauth2-id:t1}}',
    };
    // A token stored in the collection by an earlier version is replaced by the reference.
    const legacy = withAuthValue(
      withAuthValue(readAuth({ type: 'oauth2', oauth2: [] }), 'refreshToken', 'old'),
      'expiresAt',
      5,
    );
    const stored = withOAuth2Token(legacy, token);
    expect(stored.values).toMatchObject({
      accessToken: '{{vault:nexo-oauth2:t1}}',
      oauth2TokenId: 't1',
      tokenType: 'Bearer',
    });
    expect(stored.values['refreshToken']).toBeUndefined();
    expect(stored.values['expiresAt']).toBeUndefined();
    expect(selectedToken(stored, [token])).toBe(token);

    const identity = withOAuth2Token(withAuthValue(legacy, 'tokenSource', 'id_token'), token);
    expect(identity.values['accessToken']).toBe('{{vault:nexo-oauth2-id:t1}}');

    const custom = withCustomToken(stored, 'pasted');
    expect(custom.values['accessToken']).toBe('pasted');
    expect(selectedToken(custom, [token])).toBeUndefined();

    expect(autoRefreshes(stored)).toBe(true);
    expect(autoRefreshes(withAuthValue(stored, 'autoRefreshToken', false))).toBe(false);
  });

  it('masks literal secrets but shows references and non-secret fields', () => {
    expect(authDetails(readAuth(bearer('s3cret')))).toEqual([
      { key: 'token', value: 's3cret', secret: true },
    ]);
    expect(authDetails(readAuth(bearer('{{token}}')))[0].secret).toBe(false);
    const apiKey = readAuth({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-API-Key' },
        { key: 'value', value: 'k' },
      ],
    });
    expect(authDetails(apiKey).map((row) => [row.key, row.secret])).toEqual([
      ['key', false],
      ['value', true],
      ['in', false],
    ]);
  });

  it('masks the Hawk key in inherited details, also under the Insomnia name', () => {
    const details = (auth: unknown) =>
      authDetails(readAuth(auth))
        .filter((row) => row.secret)
        .map((row) => row.key);
    expect(
      details({
        type: 'hawk',
        hawk: [
          { key: 'authId', value: 'id' },
          { key: 'authKey', value: 'k1' },
          { key: 'key', value: 'k2' },
        ],
      }),
    ).toEqual(['authKey', 'key']);
    expect(details({ type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }] })).toEqual([]);
  });

  it('keeps the NTLM username, password, domain and workstation', () => {
    const stored = {
      type: 'ntlm',
      ntlm: [
        { key: 'username', value: 'ada', type: 'string' },
        { key: 'password', value: 'secret', type: 'string' },
        { key: 'domain', value: 'CORP', type: 'string' },
        { key: 'workstation', value: 'PC-1', type: 'string' },
      ],
    };
    const draft = readAuth(stored);
    expect(draft.username).toBe('ada');
    const saved = writeAuth({ ...draft, password: 'changed' }) as typeof stored;
    expect(saved.ntlm).toEqual(
      expect.arrayContaining([
        { key: 'username', value: 'ada', type: 'string' },
        { key: 'password', value: 'changed', type: 'string' },
        { key: 'domain', value: 'CORP', type: 'string' },
        { key: 'workstation', value: 'PC-1', type: 'string' },
      ]),
    );
  });

  it('signs in before sending only for browser grants that auto-fetch without a usable token', () => {
    const now = 1_000_000;
    const auth = (values: Record<string, unknown>) =>
      readAuth({
        type: 'oauth2',
        oauth2: Object.entries({
          grant_type: 'authorization_code',
          tokenName: 'SSO',
          ...values,
        }).map(([key, value]) => ({ key, value })),
      });
    const token = (extra: Partial<OAuth2Token>): OAuth2Token => ({
      id: 't1',
      name: 'SSO',
      hasRefreshToken: false,
      hasIdToken: false,
      reference: '{{vault:nexo-oauth2:t1}}',
      idReference: '{{vault:nexo-oauth2-id:t1}}',
      ...extra,
    });
    const fetching = auth({ autoFetchToken: true });
    expect(needsSignIn(fetching, [], now)).toBe(true);
    expect(needsSignIn(fetching, [token({ expiresAt: now + 120_000 })], now)).toBe(false);
    // Expired: a new sign-in, unless it can be refreshed.
    expect(needsSignIn(fetching, [token({ expiresAt: now + 30_000 })], now)).toBe(true);
    expect(needsSignIn(fetching, [token({ expiresAt: now - 1, hasRefreshToken: true })], now)).toBe(
      false,
    );
    // Another name does not count; the selected token does.
    expect(needsSignIn(fetching, [token({ name: 'OTHER' })], now)).toBe(true);
    expect(
      needsSignIn(
        auth({ autoFetchToken: true, oauth2TokenId: 't1' }),
        [token({ name: 'OTHER' })],
        now,
      ),
    ).toBe(false);
    // Off, a custom token, or a grant without a browser: no sign-in.
    expect(needsSignIn(auth({}), [], now)).toBe(false);
    expect(needsSignIn(auth({ autoFetchToken: true, accessToken: 'typed' }), [], now)).toBe(false);
    expect(
      needsSignIn(auth({ autoFetchToken: true, grant_type: 'client_credentials' }), [], now),
    ).toBe(false);
  });
});

describe('isReturnedAddress', () => {
  it('recognizes what the provider sends back to the Callback URL', () => {
    for (const address of [
      'https://front.example.com/callback?code=abc&state=1',
      ' https://front.example.com/callback#access_token=t&token_type=Bearer ',
      'https://front.example.com/callback#id_token=x',
      'https://front.example.com/callback?error=access_denied',
    ])
      expect(isReturnedAddress(address), address).toBe(true);
    for (const text of ['https://front.example.com/callback', 'code=abc', 'not a url', ''])
      expect(isReturnedAddress(text), text).toBe(false);
  });
});
