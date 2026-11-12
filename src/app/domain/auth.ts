import type { Collection, CollectionItem } from './models';

export {
  autoFetches,
  autoRefreshes,
  isReturnedAddress,
  needsSignIn,
  oauth2Grant,
  oauth2Grants,
  oauth2Shows,
  oauth2UsesBrowser,
  selectedToken,
  usableToken,
  withCustomToken,
  withOAuth2Token,
} from './auth/oauth2';
export type {
  OAuth2Field,
  OAuth2Grant,
  OAuth2SignIn,
  OAuth2SignInStatus,
  OAuth2Token,
  OAuth2TokenDetails,
} from './auth/oauth2';

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
