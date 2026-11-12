/** Connection strings: read into the connection form and written back from it. */

import { AUTH_CHOICES, type AuthChoice, type ConnectionForm, emptyConnectionForm } from '../mongo';

/** A URI split into its parts, with the password if it had one. */
export interface ParsedUri {
  form: ConnectionForm;
  password?: string;
}

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
/** Percent-encodes a user name or password; template variables stay as written. */
function encodeCredential(text: string) {
  return text
    .split(/(\{\{[^{}]*\}\})/)
    .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part)))
    .join('');
}

/** Options the form shows in fields; the rest are kept in `extra`. */
const FORM_OPTIONS = [
  'replicaSet',
  'authMechanism',
  'authSource',
  'tls',
  'ssl',
  'tlsAllowInvalidCertificates',
  'tlsInsecure',
  'readPreference',
  'readPreferenceTags',
  'w',
  'wtimeoutMS',
  'journal',
  'connectTimeoutMS',
  'socketTimeoutMS',
  'serverSelectionTimeoutMS',
  'retryWrites',
  'directConnection',
  'loadBalanced',
];
const formOption = (key: string) =>
  FORM_OPTIONS.find((option) => option.toLowerCase() === key.toLowerCase());

/** Reads a MongoDB URI into the form. Throws an error that says what is wrong. */
export function parseMongoUri(text: string): ParsedUri {
  const uri = text.trim();
  const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(uri);
  if (!scheme) throw new Error('A MongoDB URI starts with mongodb:// or mongodb+srv://');
  const rest = uri.slice(scheme[0].length);
  const queryAt = rest.indexOf('?');
  const beforeQuery = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const query = queryAt < 0 ? '' : rest.slice(queryAt + 1);
  const slash = beforeQuery.indexOf('/');
  const authority = slash < 0 ? beforeQuery : beforeQuery.slice(0, slash);
  const database = slash < 0 ? '' : decode(beforeQuery.slice(slash + 1));
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? '' : authority.slice(0, at);
  const hostList = at < 0 ? authority : authority.slice(at + 1);
  if (!hostList) throw new Error('The URI has no host');

  // A colon outside template variables separates the password.
  let username = userinfo;
  let password: string | undefined;
  const plain = userinfo.replace(/\{\{[^{}]*\}\}/g, (match) => '_'.repeat(match.length));
  const colon = plain.indexOf(':');
  if (colon >= 0) {
    username = userinfo.slice(0, colon);
    password = decode(userinfo.slice(colon + 1));
  }
  const form: ConnectionForm = {
    ...emptyConnectionForm(),
    srv: scheme[1].toLowerCase() === 'mongodb+srv',
    hosts: hostList.split(',').join('\n'),
    database,
    username: decode(username),
    tls: scheme[1].toLowerCase() === 'mongodb+srv',
  };
  const extra: string[] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const equals = pair.indexOf('=');
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : decode(pair.slice(equals + 1));
    const key = formOption(rawKey);
    const yes = value === 'true';
    switch (key) {
      case 'replicaSet':
        form.replicaSet = value;
        break;
      case 'authMechanism':
        form.auth = (AUTH_CHOICES as readonly string[]).includes(value)
          ? (value as AuthChoice)
          : 'default';
        if (!(AUTH_CHOICES as readonly string[]).includes(value)) extra.push(pair);
        break;
      case 'authSource':
        form.authSource = value;
        break;
      case 'tls':
      case 'ssl':
        form.tls = yes;
        break;
      case 'tlsAllowInvalidCertificates':
      case 'tlsInsecure':
        form.allowInvalidCertificates = yes;
        if (yes) form.tls = true;
        break;
      case 'readPreference':
        form.readPreference = value;
        break;
      case 'readPreferenceTags':
        form.readPreferenceTags = value;
        break;
      case 'w':
        form.w = value;
        break;
      case 'wtimeoutMS':
      case 'connectTimeoutMS':
      case 'socketTimeoutMS':
      case 'serverSelectionTimeoutMS':
        form[key] = value;
        break;
      case 'journal':
        form.journal = yes;
        break;
      case 'retryWrites':
        form.retryWrites = value !== 'false';
        break;
      case 'directConnection':
        form.directConnection = yes;
        break;
      case 'loadBalanced':
        form.loadBalanced = yes;
        break;
      default:
        extra.push(pair);
    }
  }
  form.extra = extra.join('&');
  if (form.auth === 'none' && (form.username || password !== undefined)) form.auth = 'default';
  return password === undefined ? { form } : { form, password };
}

/** Writes the URI of a form, never with a password. */
export function formatMongoUri(form: ConnectionForm): string {
  const hosts = form.hosts
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter(Boolean);
  const signsIn = form.auth !== 'none' && form.username.trim();
  const userinfo = signsIn ? `${encodeCredential(form.username.trim())}@` : '';
  const options: string[] = [];
  const add = (key: string, value: string | boolean) => {
    options.push(`${key}=${typeof value === 'string' ? encodeURIComponent(value) : value}`);
  };
  if (form.replicaSet.trim()) add('replicaSet', form.replicaSet.trim());
  if (form.auth !== 'none' && form.auth !== 'default') add('authMechanism', form.auth);
  if (form.auth !== 'none' && form.authSource.trim()) add('authSource', form.authSource.trim());
  // `mongodb+srv://` turns TLS on by itself.
  if (form.tls !== form.srv) add('tls', form.tls);
  if (form.tls && form.allowInvalidCertificates) add('tlsAllowInvalidCertificates', true);
  if (form.readPreference) add('readPreference', form.readPreference);
  if (form.readPreferenceTags.trim()) {
    options.push(`readPreferenceTags=${form.readPreferenceTags.trim()}`);
  }
  if (form.w.trim()) add('w', form.w.trim());
  for (const key of [
    'wtimeoutMS',
    'connectTimeoutMS',
    'socketTimeoutMS',
    'serverSelectionTimeoutMS',
  ] as const) {
    if (form[key].trim()) add(key, form[key].trim());
  }
  if (form.journal) add('journal', true);
  if (!form.retryWrites) add('retryWrites', false);
  if (form.directConnection) add('directConnection', true);
  if (form.loadBalanced) add('loadBalanced', true);
  const extra = form.extra.trim().replace(/^[?&]+/, '');
  if (extra) options.push(extra);
  const path = form.database.trim() ? encodeURIComponent(form.database.trim()) : '';
  const query = options.length ? `?${options.join('&')}` : '';
  return `${form.srv ? 'mongodb+srv' : 'mongodb'}://${userinfo}${hosts.join(',')}/${path}${query}`;
}
