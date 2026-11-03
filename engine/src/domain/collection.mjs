import { randomUUID } from 'node:crypto';

export const collectionSchema = 'urn:nexo:collection:1';
export function requestItem(input = {}) {
  if (typeof input.request === 'object' && !input.method) return structuredClone(input);
  const headers = (input.headers ?? [])
    .filter((h) => h.enabled !== false && h.key)
    .map((h) => ({ key: h.key, value: h.value ?? '', disabled: false }));
  let url = input.url ?? '';
  const query = (input.query ?? []).filter((q) => q.enabled !== false && q.key);
  if (query.length)
    url +=
      (url.includes('?') ? '&' : '?') +
      query
        .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`)
        .join('&');
  let auth = input.auth ?? { type: 'noauth' };
  if (auth.type === 'bearer')
    auth = { type: 'bearer', bearer: [{ key: 'token', value: auth.token ?? '', type: 'string' }] };
  else if (auth.type === 'basic')
    auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: auth.username ?? '', type: 'string' },
        { key: 'password', value: auth.password ?? '', type: 'string' },
      ],
    };
  else if (auth.type === 'apikey')
    auth = {
      type: 'apikey',
      apikey: [
        { key: 'key', value: auth.key ?? 'X-API-Key' },
        { key: 'value', value: auth.value ?? '' },
        { key: 'in', value: auth.in ?? 'header' },
      ],
    };
  else if (auth.values)
    auth = {
      [auth.type]: Object.entries({
        ...auth.values,
        username: auth.username,
        password: auth.password,
        ...JSON.parse(auth.parameters || '{}'),
      }).map(([key, value]) => ({ key, value, type: 'string' })),
      type: auth.type,
    };
  let body = {
    mode: 'raw',
    raw: input.body ?? '',
    options: { raw: { language: input.bodyLanguage ?? 'json' } },
  };
  if (input.bodyMode === 'urlencoded')
    body = {
      mode: 'urlencoded',
      urlencoded: (input.form ?? [])
        .filter((x) => x.enabled !== false)
        .map((x) => ({ key: x.key, value: x.value, type: 'text' })),
    };
  if (input.bodyMode === 'formdata')
    body = {
      mode: 'formdata',
      formdata: (input.form ?? [])
        .filter((x) => x.enabled !== false)
        .map((x) => ({ key: x.key, value: x.value, type: 'text' })),
    };
  if (input.protocol === 'graphql') {
    body = {
      mode: 'graphql',
      graphql: { query: input.body ?? '', variables: input.graphqlVariables ?? '{}' },
    };
  }
  const event = [
    ['prerequest', input.prerequest],
    ['test', input.tests],
  ]
    .filter(([, source]) => source)
    .map(([listen, source]) => ({
      listen,
      script: { type: 'text/javascript', exec: source.split('\n') },
    }));
  return {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'Untitled request',
    request: {
      method: input.method ?? 'GET',
      url,
      header: headers,
      auth: auth.type === 'inherit' ? undefined : auth,
      body,
    },
    event,
  };
}
export function asCollection(payload) {
  if (payload.collection?.item) return structuredClone(payload.collection);
  return {
    info: { name: payload.request?.name ?? 'Request', schema: collectionSchema },
    item: [requestItem(payload.request)],
  };
}
export function validateUrl(url, protocols = ['http:', 'https:']) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('A complete URL is required');
  }
  if (!protocols.includes(parsed.protocol))
    throw new Error(`Unsupported URL protocol ${parsed.protocol}`);
  return parsed;
}
