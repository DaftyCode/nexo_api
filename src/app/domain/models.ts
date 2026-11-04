export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}
export type Protocol = 'http' | 'graphql' | 'grpc' | 'websocket' | 'socketio' | 'mqtt';
export interface RequestDraft {
  id: string;
  name: string;
  protocol: Protocol;
  method: string;
  url: string;
  headers: KeyValue[];
  query: KeyValue[];
  form: KeyValue[];
  body: string;
  bodyMode: string;
  bodyLanguage: string;
  graphqlVariables: string;
  auth: {
    type: string;
    token: string;
    username: string;
    password: string;
    key: string;
    value: string;
    in: string;
    values: Record<string, string>;
    parameters: string;
  };
  prerequest: string;
  tests: string;
  timeout: number;
  strictSSL: boolean;
  followRedirects: boolean;
  transport: string;
  /** WebSocket, Socket.IO, MQTT and gRPC settings edited in the protocols panel. */
  realtime?: RealtimeSettings;
}
export interface RealtimeSettings {
  protocol: 'websocket' | 'socketio' | 'mqtt' | 'grpc';
  url: string;
  message: string;
  grpcMessage: string;
  topic: string;
  event: string;
  proto: string;
  service: string;
  method: string;
  metadata: string;
  tls: boolean;
  strictSSL: boolean;
  caPem: string;
  username: string;
  password: string;
  qos: string;
  headers: KeyValue[];
}
const realtimeProtocols = ['websocket', 'socketio', 'mqtt', 'grpc'];
const isReference = (value: string) => /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
/** Realtime settings as stored in a collection: literal passwords are never written. */
export function storedRealtime(settings: RealtimeSettings): RealtimeSettings {
  return { ...settings, password: isReference(settings.password) ? settings.password : '' };
}
function readRealtime(value: unknown): RealtimeSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const settings = value as RealtimeSettings;
  return realtimeProtocols.includes(settings.protocol) ? settings : undefined;
}
export interface Assertion {
  name: string;
  passed: boolean;
  skipped: boolean;
  error?: string;
  iteration?: number;
}
export interface ExecutionResponse {
  status: number;
  statusText: string;
  body: string;
  headers: KeyValue[];
  time: number;
  size: number;
  assertions: Assertion[];
  logs: { level: string; values: string[] }[];
  error?: string;
  truncated?: boolean;
  /** `base64` when the body is binary (images, archives, PDFs). */
  bodyEncoding?: 'base64';
  warnings?: string[];
  cookies?: unknown[];
  request?: unknown;
  executionId?: string;
  /** Final value of each variable scope after the request scripts ran. */
  variables?: { environment?: unknown; globals?: unknown; collection?: unknown };
}
export interface WorkspaceDocument {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  revision: number;
  updated_at: number;
  value: unknown;
}
export interface Workspace {
  id: string;
  name: string;
}
/** Service status. `mode` is `desktop` in the app window and `web` in a browser. */
export interface Health {
  name: string;
  version: string;
  mode: 'desktop' | 'web';
  engineReady: boolean;
}
export interface Run {
  id: string;
  state: string;
  results: ExecutionResponse[];
  assertions: Assertion[];
  logs: unknown[];
  error?: string;
  duration?: number;
  environment?: unknown;
  globals?: unknown;
  collectionVariables?: unknown;
  /** Totals so far; send them back to receive only newer entries. */
  counts?: RunCounts;
}
export interface RunCounts {
  results: number;
  assertions: number;
  logs: number;
}
/** Adds an incremental status update to the run received so far. */
export function mergeRun(previous: Run, update: Run): Run {
  return {
    ...update,
    results: [...previous.results, ...update.results],
    assertions: [...previous.assertions, ...update.assertions],
    logs: [...previous.logs, ...update.logs],
  };
}
export interface RequestTab {
  id: string;
  request: RequestDraft;
  documentId: string;
  path: number[];
  dirty: boolean;
}
export interface CollectionItem {
  id?: string;
  name: string;
  item?: CollectionItem[];
  request?: Record<string, unknown> | string;
  event?: { listen: string; script: { exec: string[] | string } }[];
  [key: string]: unknown;
}
export interface Collection {
  info: { name: string; schema: string; [key: string]: unknown };
  item: CollectionItem[];
  [key: string]: unknown;
}
export const schema = 'urn:nexo:collection:1';
/** Percent-encodes query text but keeps `{{variable}}` placeholders so they still resolve. */
export function encodeQueryPart(value: string): string {
  return String(value)
    .split(/(\{\{[^{}]+\}\})/)
    .map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? part : encodeURIComponent(part)))
    .join('');
}
export const row = (key = '', value = ''): KeyValue => ({ key, value, enabled: true });
function decodeQueryPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
/**
 * Splits the query of a saved URL into editable rows. URLs whose query would not be written
 * back identically (fragments, `+`, keys without `=`, unusual escapes) stay whole.
 */
export function splitQuery(url: string): { url: string; query: KeyValue[] } {
  const index = url.indexOf('?');
  if (index < 0 || url.includes('#') || index === url.length - 1) return { url, query: [] };
  const query: KeyValue[] = [];
  for (const part of url.slice(index + 1).split('&')) {
    const separator = part.indexOf('=');
    if (separator < 1) return { url, query: [] };
    const rawKey = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    const key = decodeQueryPart(rawKey);
    const value = decodeQueryPart(rawValue);
    if (key === undefined || value === undefined) return { url, query: [] };
    if (encodeQueryPart(key) !== rawKey || encodeQueryPart(value) !== rawValue)
      return { url, query: [] };
    query.push(row(key, value));
  }
  return { url: url.slice(0, index), query };
}
function authParameters(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new Error('Authorization parameters must be a JSON object');
}
export function newRequest(id: string): RequestDraft {
  return {
    id,
    name: 'Untitled request',
    protocol: 'http',
    method: 'GET',
    url: '',
    headers: [row()],
    query: [row()],
    form: [row()],
    body: '',
    bodyMode: 'raw',
    bodyLanguage: 'json',
    graphqlVariables: '{}',
    auth: {
      type: 'noauth',
      token: '',
      username: '',
      password: '',
      key: 'X-API-Key',
      value: '',
      in: 'header',
      values: {},
      parameters: '{}',
    },
    prerequest: '',
    tests: '',
    timeout: 30000,
    strictSSL: true,
    followRedirects: true,
    transport: '{}',
  };
}
export function asCollection(value: unknown): Collection {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Collection).item))
    throw new Error('Invalid collection');
  return value as Collection;
}
/** A stored `{key, value, disabled}` row as an editor row. */
function editableRow(x: { key: string; value: unknown; disabled?: boolean }): KeyValue {
  return { key: String(x.key ?? ''), value: String(x.value ?? ''), enabled: !x.disabled };
}
export function fromItem(item: CollectionItem, id: string): RequestDraft {
  const draft = newRequest(id);
  draft.name = item.name;
  draft.transport = typeof item['nexoTransport'] === 'string' ? item['nexoTransport'] : '{}';
  const realtime = readRealtime(item['nexoProtocol']);
  if (realtime) {
    draft.realtime = realtime;
    draft.protocol = realtime.protocol;
  }
  const request = typeof item.request === 'string' ? { url: item.request } : (item.request ?? {});
  draft.method = String(request['method'] ?? 'GET');
  const url = request['url'];
  const split = splitQuery(
    typeof url === 'string' ? url : String((url as Record<string, unknown>)?.['raw'] ?? ''),
  );
  draft.url = split.url;
  const disabled = Array.isArray(item['nexoDisabledQuery'])
    ? (item['nexoDisabledQuery'] as { key: string; value: string }[]).map((x) => ({
        key: String(x.key),
        value: String(x.value ?? ''),
        enabled: false,
      }))
    : [];
  draft.query = split.query.length || disabled.length ? [...split.query, ...disabled] : [row()];
  draft.headers = Array.isArray(request['header'])
    ? (request['header'] as { key: string; value: string; disabled?: boolean }[]).map(editableRow)
    : [row()];
  const body = request['body'] as Record<string, unknown> | undefined;
  if (body) {
    draft.bodyMode = String(body['mode'] ?? 'raw');
    draft.body = String(body['raw'] ?? '');
    if (body['mode'] === 'graphql') {
      draft.protocol = 'graphql';
      draft.bodyMode = 'raw';
      const gql = body['graphql'] as Record<string, string>;
      draft.body = gql?.['query'] ?? '';
      draft.graphqlVariables = gql?.['variables'] ?? '{}';
    }
    if (Array.isArray(body[draft.bodyMode]))
      draft.form = (
        body[draft.bodyMode] as { key: string; value: string; disabled?: boolean }[]
      ).map(editableRow);
  }
  const auth = request['auth'] as Record<string, unknown> | undefined;
  if (auth) {
    draft.auth.type = String(auth['type'] ?? 'noauth');
    const values = auth[draft.auth.type];
    if (Array.isArray(values))
      for (const v of values as { key: string; value: string }[]) {
        draft.auth.values[v.key] = v.value;
        if (v.key in draft.auth)
          (draft.auth as unknown as Record<string, unknown>)[v.key] = v.value;
      }
    draft.auth.parameters = JSON.stringify(draft.auth.values, null, 2);
  } else draft.auth.type = 'inherit';
  for (const event of item.event ?? []) {
    const script = Array.isArray(event.script.exec)
      ? event.script.exec.join('\n')
      : event.script.exec;
    if (event.listen === 'test') draft.tests = script;
    if (event.listen === 'prerequest') draft.prerequest = script;
  }
  return draft;
}
export function toItem(draft: RequestDraft, existing?: CollectionItem): CollectionItem {
  const headers = draft.headers
    .filter((x) => x.key)
    .map((x) => ({ key: x.key, value: x.value, disabled: !x.enabled }));
  let url = draft.url;
  const query = draft.query.filter((x) => x.enabled && x.key);
  if (query.length)
    url +=
      (url.includes('?') ? '&' : '?') +
      query.map((x) => `${encodeQueryPart(x.key)}=${encodeQueryPart(x.value)}`).join('&');
  const values =
    draft.auth.type === 'bearer'
      ? { token: draft.auth.token }
      : draft.auth.type === 'basic'
        ? { username: draft.auth.username, password: draft.auth.password }
        : draft.auth.type === 'apikey'
          ? { key: draft.auth.key, value: draft.auth.value, in: draft.auth.in }
          : {
              ...draft.auth.values,
              username: draft.auth.username,
              password: draft.auth.password,
              ...authParameters(draft.auth.parameters),
            };
  const auth =
    draft.auth.type === 'inherit'
      ? undefined
      : {
          type: draft.auth.type,
          [draft.auth.type]: Object.entries(values).map(([key, value]) => ({
            key,
            value,
            type: 'string',
          })),
        };
  const body =
    draft.protocol === 'graphql'
      ? { mode: 'graphql', graphql: { query: draft.body, variables: draft.graphqlVariables } }
      : draft.bodyMode === 'raw'
        ? { mode: 'raw', raw: draft.body, options: { raw: { language: draft.bodyLanguage } } }
        : {
            mode: draft.bodyMode,
            [draft.bodyMode]: draft.form
              .filter((x) => x.key)
              .map((x) => ({ key: x.key, value: x.value, disabled: !x.enabled, type: 'text' })),
          };
  const disabledQuery = draft.query
    .filter((x) => !x.enabled && x.key)
    .map((x) => ({ key: x.key, value: x.value }));
  const { nexoDisabledQuery: _previous, ...kept } = existing ?? ({} as CollectionItem);
  return {
    ...kept,
    ...(disabledQuery.length ? { nexoDisabledQuery: disabledQuery } : {}),
    id: existing?.id ?? draft.id,
    name: draft.name,
    nexoTransport: draft.transport,
    ...(draft.realtime ? { nexoProtocol: storedRealtime(draft.realtime) } : {}),
    request: {
      ...(typeof existing?.request === 'object' ? existing.request : {}),
      method: draft.method,
      url,
      header: headers,
      auth,
      body,
    },
    event: [
      { listen: 'prerequest', script: { exec: draft.prerequest.split('\n') } },
      { listen: 'test', script: { exec: draft.tests.split('\n') } },
    ],
  };
}
export function items(
  collection: Collection,
): { item: CollectionItem; path: number[]; depth: number }[] {
  const result: { item: CollectionItem; path: number[]; depth: number }[] = [];
  function walk(nodes: CollectionItem[], path: number[]) {
    nodes.forEach((item, i) => {
      const next = [...path, i];
      result.push({ item, path: next, depth: path.length });
      if (item.item) walk(item.item, next);
    });
  }
  walk(collection.item, []);
  return result;
}
export function updateItem(
  collection: Collection,
  path: number[],
  item: CollectionItem,
): Collection {
  const next = structuredClone(collection);
  let list = next.item;
  for (const index of path.slice(0, -1)) list = list[index].item ??= [];
  list[path.at(-1) ?? list.length] = item;
  return next;
}
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
