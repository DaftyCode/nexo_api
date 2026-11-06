import type { Collection, CollectionItem } from './models';

/** Editable authorization of a request, folder or collection. */
export interface AuthDraft {
  /** A stored type (`bearer`, `basic`, `oauth2`…) or `inherit` when none is stored. */
  type: string;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  in: string;
  /** Every stored value of the type, including those without a dedicated field. */
  values: Record<string, string>;
  /** `values` as JSON, edited for the types without dedicated fields. */
  parameters: string;
}

/** Authorization that a request or folder takes from the nearest folder or collection. */
export interface InheritedAuth {
  /** Name of the folder or collection that sets it. */
  name: string;
  /** Path of that folder; empty for the collection itself. */
  path: number[];
  auth: AuthDraft;
}

/**
 * What an item set to "Inherit from parent" receives: the nearest folder or collection that
 * sets an authorization, or no `source` when none does.
 */
export interface Inheritance {
  source?: InheritedAuth;
}

const fieldKeys = ['token', 'username', 'password', 'key', 'value', 'in'] as const;

export function emptyAuth(type = 'noauth'): AuthDraft {
  return {
    type,
    token: '',
    username: '',
    password: '',
    key: 'X-API-Key',
    value: '',
    in: 'header',
    values: {},
    parameters: '{}',
  };
}

function isAuth(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a stored `{type, [type]: [{key, value}]}` authorization; `missing` is used without one. */
export function readAuth(stored: unknown, missing = 'inherit'): AuthDraft {
  const draft = emptyAuth(missing);
  if (!isAuth(stored)) return draft;
  draft.type = String(stored['type'] ?? 'noauth');
  const values = stored[draft.type];
  if (Array.isArray(values))
    for (const entry of values as { key?: unknown; value?: unknown }[]) {
      if (!entry || typeof entry.key !== 'string') continue;
      // Kept as stored: OAuth 2 settings may be booleans or lists.
      draft.values[entry.key] = entry.value as string;
      if ((fieldKeys as readonly string[]).includes(entry.key))
        draft[entry.key as (typeof fieldKeys)[number]] = String(entry.value ?? '');
    }
  draft.parameters = JSON.stringify(draft.values, null, 2);
  return draft;
}

function parameters(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (isAuth(value)) return value;
  } catch {
    // Reported below.
  }
  throw new Error('Authorization parameters must be a JSON object');
}

/** The authorization to store, or `undefined` to inherit it. */
export function writeAuth(draft: AuthDraft): Record<string, unknown> | undefined {
  if (draft.type === 'inherit') return undefined;
  // Options other tools add (Insomnia's Basic encoding and Bearer prefix) are kept when set.
  const optional = (...keys: string[]) =>
    Object.fromEntries(
      keys.filter((key) => draft.values[key] !== undefined).map((key) => [key, draft.values[key]]),
    );
  const values =
    draft.type === 'bearer'
      ? { token: draft.token, ...optional('prefix') }
      : draft.type === 'basic'
        ? { username: draft.username, password: draft.password, ...optional('useISO88591') }
        : draft.type === 'apikey'
          ? { key: draft.key, value: draft.value, in: draft.in }
          : {
              ...draft.values,
              ...parameters(draft.parameters),
              // The username and password fields win over a stale JSON copy. Only when used:
              // OAuth 2 and others never had these fields.
              ...(draft.username || 'username' in draft.values ? { username: draft.username } : {}),
              ...(draft.password || 'password' in draft.values ? { password: draft.password } : {}),
            };
  return {
    type: draft.type,
    [draft.type]: Object.entries(values).map(([key, value]) => ({ key, value, type: 'string' })),
  };
}

/**
 * The authorization that the item at `path` inherits: the one of the nearest folder above it,
 * else the collection's, as the engine applies it. `undefined` when none of them sets one.
 */
export function inheritedAuth(
  collection: Collection,
  path: readonly number[],
): InheritedAuth | undefined {
  const sources: InheritedAuth[] = [];
  const add = (name: string, at: number[], stored: unknown) => {
    if (isAuth(stored)) sources.push({ name, path: at, auth: readAuth(stored) });
  };
  add(collection.info?.name ?? 'Collection', [], collection['auth']);
  let list: CollectionItem[] | undefined = collection.item;
  for (const [depth, index] of path.slice(0, -1).entries()) {
    const folder: CollectionItem | undefined = list?.[index];
    if (!folder?.item) break;
    add(folder.name, path.slice(0, depth + 1), folder['auth']);
    list = folder.item;
  }
  return sources.at(-1);
}

/** OAuth 2.0 grant types as Postman stores them in `grant_type`. */
export const oauth2Grants = [
  'authorization_code',
  'authorization_code_with_pkce',
  'implicit',
  'password_credentials',
  'client_credentials',
] as const;
export type OAuth2Grant = (typeof oauth2Grants)[number];

/** Settings of "Configure New Token" that each grant type shows, as in Postman. */
export type OAuth2Field =
  | 'redirect_uri'
  | 'authUrl'
  | 'accessTokenUrl'
  | 'clientSecret'
  | 'challengeAlgorithm'
  | 'code_verifier'
  | 'username'
  | 'password'
  | 'state'
  | 'client_authentication'
  | 'authRequestParams';

const browserFields: OAuth2Field[] = ['redirect_uri', 'authUrl', 'state', 'authRequestParams'];
const oauth2FieldsByGrant: Record<OAuth2Grant, OAuth2Field[]> = {
  authorization_code: [...browserFields, 'accessTokenUrl', 'clientSecret', 'client_authentication'],
  authorization_code_with_pkce: [
    ...browserFields,
    'accessTokenUrl',
    'clientSecret',
    'client_authentication',
    'challengeAlgorithm',
    'code_verifier',
  ],
  implicit: browserFields,
  password_credentials: [
    'accessTokenUrl',
    'username',
    'password',
    'clientSecret',
    'client_authentication',
  ],
  client_credentials: ['accessTokenUrl', 'clientSecret', 'client_authentication'],
};

/** The grant type of an OAuth 2.0 authorization; Postman's default is Authorization Code. */
export function oauth2Grant(auth: AuthDraft): OAuth2Grant {
  const stored = String(auth.values['grant_type'] ?? '');
  if (stored === 'password') return 'password_credentials';
  return (oauth2Grants as readonly string[]).includes(stored)
    ? (stored as OAuth2Grant)
    : 'authorization_code';
}

export function oauth2Shows(auth: AuthDraft, field: OAuth2Field): boolean {
  return oauth2FieldsByGrant[oauth2Grant(auth)].includes(field);
}

/** Whether the grant type signs in through a browser window. */
export function oauth2UsesBrowser(auth: AuthDraft): boolean {
  return oauth2Shows(auth, 'authUrl');
}

/** A copy of an authorization with one stored value changed (`undefined` removes it). */
export function withAuthValue(auth: AuthDraft, key: string, value: unknown): AuthDraft {
  const values: Record<string, string> = { ...auth.values };
  if (value === undefined) delete values[key];
  else values[key] = value as string;
  const next = { ...auth, values, parameters: JSON.stringify(values, null, 2) };
  if ((fieldKeys as readonly string[]).includes(key))
    next[key as (typeof fieldKeys)[number]] = value === undefined ? '' : String(value);
  return next;
}

/**
 * A token kept in the vault, as the engine describes it: without its values. `reference` and
 * `idReference` are the variables a request uses for its access and ID tokens.
 */
export interface OAuth2Token {
  id: string;
  name: string;
  tokenType?: string | null;
  scope?: string | null;
  expiresAt?: number | null;
  obtainedAt?: number | null;
  hasRefreshToken: boolean;
  hasIdToken: boolean;
  reference: string;
  idReference: string;
}

/** Every value of a stored token, shown in "Manage Tokens". */
export interface OAuth2TokenDetails {
  accessToken?: string | null;
  idToken?: string | null;
  refreshToken?: string | null;
}

/** A browser sign-in in progress (`oauth2.authorize`). */
export interface OAuth2SignIn {
  session: string;
  authorizationUrl: string;
  /** Loopback Callback URL, Nexo's callback page, or pasting the returned address. */
  mode: 'loopback' | 'relay' | 'manual';
  redirectUri: string;
  /** Whether the system browser (or the app's sign-in window) was opened. */
  opened: boolean;
  /** Shown in the desktop app's sign-in window instead of the system browser. */
  window?: boolean;
}

/**
 * Whether a pasted address is what the provider sends back to the Callback URL: an address
 * with a code, a token or an error, in its query or its fragment.
 */
export function isReturnedAddress(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  const parameters = new URLSearchParams(url.search);
  new URLSearchParams(url.hash.slice(1)).forEach((value, key) => parameters.append(key, value));
  return ['code', 'access_token', 'id_token', 'error'].some((key) => parameters.has(key));
}

export interface OAuth2SignInStatus {
  state: 'waiting' | 'done' | 'error' | 'cancelled';
  token?: OAuth2Token;
  error?: string;
}

/**
 * Uses a stored token, as choosing it in Postman's "Available Tokens": the authorization keeps
 * a reference to the vault entry (`{{vault:nexo-oauth2:<id>}}`) and the token id, never the
 * token. With "Use Token Type: ID token" the ID token is sent instead.
 */
export function withOAuth2Token(auth: AuthDraft, token: OAuth2Token): AuthDraft {
  const identity = auth.values['tokenSource'] === 'id_token' && token.hasIdToken;
  let next = withAuthValue(auth, 'accessToken', identity ? token.idReference : token.reference);
  next = withAuthValue(next, 'oauth2TokenId', token.id);
  next = withAuthValue(next, 'tokenType', token.tokenType ?? undefined);
  // Earlier versions stored these in the collection; tokens now live in the vault.
  next = withAuthValue(next, 'refreshToken', undefined);
  return withAuthValue(next, 'expiresAt', undefined);
}

/** "Custom token": a token typed in, not one of the stored ones. */
export function withCustomToken(auth: AuthDraft, value: string): AuthDraft {
  return withAuthValue(withAuthValue(auth, 'oauth2TokenId', undefined), 'accessToken', value);
}

/** The stored token an authorization uses, if any. */
export function selectedToken(
  auth: AuthDraft,
  tokens: readonly OAuth2Token[],
): OAuth2Token | undefined {
  const id = String(auth.values['oauth2TokenId'] ?? '');
  return id ? tokens.find((token) => token.id === id) : undefined;
}

/** Postman's "Auto-refresh Token": on unless turned off. */
export function autoRefreshes(auth: AuthDraft): boolean {
  const value = auth.values['autoRefreshToken'] as unknown;
  return value !== false && value !== 'false';
}

/** Bruno's "Auto-fetch token": off unless the authorization turns it on. */
export function autoFetches(auth: AuthDraft): boolean {
  const value = auth.values['autoFetchToken'] as unknown;
  return value === true || value === 'true';
}

/** Whether a stored token can still be used: it does not expire within a minute, or it can be refreshed. */
export function usableToken(token: OAuth2Token, now: number): boolean {
  return token.expiresAt == null || token.expiresAt > now + 60_000 || token.hasRefreshToken;
}

/**
 * Whether sending needs a browser sign-in first: the OAuth 2.0 authorization fetches its token
 * automatically, signs in through a browser, and neither its selected token nor one with its
 * name can be used. Other grants are fetched by the engine itself.
 */
export function needsSignIn(
  auth: AuthDraft | undefined,
  tokens: readonly OAuth2Token[],
  now: number,
): boolean {
  if (auth?.type !== 'oauth2' || !autoFetches(auth) || !oauth2UsesBrowser(auth)) return false;
  const selected = String(auth.values['oauth2TokenId'] ?? '');
  // A token typed in ("Custom token") is the user's choice.
  if (!selected && String(auth.values['accessToken'] ?? '')) return false;
  const name = String(auth.values['tokenName'] ?? '').trim() || 'Token';
  return !tokens.some(
    (token) => (token.id === selected || token.name === name) && usableToken(token, now),
  );
}

/** Field of an authorization shown read-only, for example where it is inherited. */
export interface AuthDetail {
  key: string;
  value: string;
  /** A literal secret, shown masked. References such as `{{token}}` are not secret. */
  secret: boolean;
}

const secretKey = /token|password|secret|signature|private|authkey|^value$/i;
const reference = /^\s*\{\{[^{}]+\}\}\s*$/;

export function authDetails(auth: AuthDraft): AuthDetail[] {
  const entries: [string, unknown][] =
    auth.type === 'bearer'
      ? [['token', auth.token]]
      : auth.type === 'basic'
        ? [
            ['username', auth.username],
            ['password', auth.password],
          ]
        : auth.type === 'apikey'
          ? [
              ['key', auth.key],
              ['value', auth.value],
              ['in', auth.in],
            ]
          : Object.entries(auth.values);
  return entries.map(([key, raw]) => {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    // Insomnia calls the Hawk key `key`, which for an API key is only the header name.
    const secret = secretKey.test(key) || (auth.type === 'hawk' && key === 'key');
    return { key, value, secret: secret && !!value && !reference.test(value) };
  });
}
