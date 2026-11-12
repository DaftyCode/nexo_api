/** OAuth 2.0: grants and their fields, browser sign-in, and the tokens a request uses. */

import { type AuthDraft, withAuthValue } from '../auth';

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
