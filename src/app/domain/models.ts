import { AuthDraft, emptyAuth, readAuth, writeAuth } from './auth';

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  /** Form-data rows: `file` sends files instead of text, as in Postman. */
  type?: 'text' | 'file';
  /** Form-data file rows: the names of their files, as collections store them. */
  src?: string | string[];
  /** Form-data rows: the media type of the part. */
  contentType?: string;
  /** Form-data file rows: the files chosen in this session; never saved. */
  files?: AttachedFile[];
}
/**
 * A file chosen to send with a request. Its content stays in the open request only:
 * collections, history and exports keep its name, as in Postman.
 */
export interface AttachedFile {
  name: string;
  contentType: string;
  size: number;
  /** Base64. */
  content: string;
}
/** A file as the engine receives it to send: the name it was chosen for and its content. */
export interface FileUpload {
  src: string;
  content: string;
  contentType?: string;
}
/** The most a request may send in files. */
export const MAX_REQUEST_FILES = 32 * 1024 * 1024;
export type Protocol =
  | 'http'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'socketio'
  | 'mqtt'
  | 'graphql-subscription'
  | 'kafka';
export interface RequestDraft {
  id: string;
  name: string;
  protocol: Protocol;
  method: string;
  url: string;
  headers: KeyValue[];
  query: KeyValue[];
  /** Values of the `:name` segments of the URL (Postman "Path Variables"). */
  pathVariables: KeyValue[];
  form: KeyValue[];
  body: string;
  bodyMode: string;
  /** Binary body (`bodyMode` `file`): the file's name and, once chosen, its content. */
  bodyFile?: { src: string; file?: AttachedFile };
  bodyLanguage: string;
  graphqlVariables: string;
  auth: AuthDraft;
  prerequest: string;
  tests: string;
  timeout: number;
  strictSSL: boolean;
  followRedirects: boolean;
  transport: string;
  /** WebSocket, Socket.IO, MQTT, gRPC and GraphQL subscription settings of the protocols panel. */
  realtime?: RealtimeSettings;
}
export interface RealtimeSettings {
  protocol: 'websocket' | 'socketio' | 'mqtt' | 'grpc' | 'graphql-subscription' | 'kafka';
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
  /** GraphQL subscriptions: the operation, its variables and `connection_init` payload (JSON). */
  query?: string;
  variables?: string;
  connectionParams?: string;
  /** `graphql-transport-ws` (current) or `graphql-ws` (`subscriptions-transport-ws`). */
  graphqlProtocol?: string;
  /** gRPC: the server describes its services by reflection; no descriptors are saved. */
  reflection?: boolean;
  /** Socket.IO: `auto` (long polling, then WebSocket), `websocket` or `polling`. */
  transports?: string;
  /** Kafka: SASL mechanism, record key and partition, and where reading starts. */
  saslMechanism?: string;
  key?: string;
  partition?: string;
  from?: string;
  offset?: string;
}
const realtimeProtocols = [
  'websocket',
  'socketio',
  'mqtt',
  'grpc',
  'graphql-subscription',
  'kafka',
];
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
  /** Name of the request whose scripts ran the test. */
  request?: string;
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
/** Names of the `:name` path segments of a URL, in order and without repeats, as Postman. */
export function pathVariableNames(url: string): string[] {
  const address = url.split(/[?#]/, 1)[0];
  const scheme = address.indexOf('://');
  const slash = scheme < 0 ? 0 : address.indexOf('/', scheme + 3);
  if (slash < 0) return [];
  const names = address
    .slice(slash)
    .split('/')
    .filter((segment) => segment.length > 1 && segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  return [...new Set(names)];
}
/** The path variables of a URL with the values already entered, one row per name. */
export function pathVariableRows(url: string, rows: readonly KeyValue[]): KeyValue[] {
  return pathVariableNames(url).map((key) => ({
    key,
    value: rows.find((row) => row.key === key)?.value ?? '',
    enabled: true,
  }));
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
    pathVariables: [],
    form: [row()],
    body: '',
    bodyMode: 'raw',
    bodyLanguage: 'json',
    graphqlVariables: '{}',
    // As in Postman, a new request takes the authorization of its folder or collection.
    auth: emptyAuth('inherit'),
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
/** A stored form-data row, which may send files (`type: file`, `src`) or set `contentType`. */
function formRow(x: Record<string, unknown>): KeyValue {
  const row = editableRow(x as { key: string; value: unknown; disabled?: boolean });
  if (typeof x['contentType'] === 'string' && x['contentType']) row.contentType = x['contentType'];
  if (x['type'] !== 'file') return row;
  const src = Array.isArray(x['src'])
    ? x['src'].filter((name): name is string => typeof name === 'string' && !!name)
    : typeof x['src'] === 'string'
      ? x['src']
      : '';
  return { ...row, value: '', type: 'file', src };
}
/** The names a file row sends, in order. */
export function fileNames(row: KeyValue): string[] {
  return (Array.isArray(row.src) ? row.src : [row.src ?? '']).filter(Boolean);
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
  const variable = typeof url === 'object' ? (url as Record<string, unknown>)?.['variable'] : [];
  draft.pathVariables = Array.isArray(variable)
    ? (variable as { key: string; value: unknown }[])
        .filter((x) => x && x.key)
        .map((x) => ({ key: String(x.key), value: String(x.value ?? ''), enabled: true }))
    : [];
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
    const options = body['options'] as { raw?: { language?: unknown } } | undefined;
    if (typeof options?.raw?.language === 'string') draft.bodyLanguage = options.raw.language;
    if (body['mode'] === 'graphql') {
      draft.protocol = 'graphql';
      draft.bodyMode = 'raw';
      const gql = body['graphql'] as Record<string, string>;
      draft.body = gql?.['query'] ?? '';
      draft.graphqlVariables = gql?.['variables'] ?? '{}';
    }
    if (body['mode'] === 'file') {
      const file = body['file'] as { src?: unknown } | undefined;
      draft.bodyFile = { src: typeof file?.src === 'string' ? file.src : '' };
    }
    if (Array.isArray(body[draft.bodyMode]))
      draft.form = (body[draft.bodyMode] as Record<string, unknown>[]).map((x) =>
        draft.bodyMode === 'formdata'
          ? formRow(x)
          : editableRow(x as { key: string; value: unknown; disabled?: boolean }),
      );
  }
  draft.auth = readAuth(request['auth']);
  for (const event of item.event ?? []) {
    const script = Array.isArray(event.script.exec)
      ? event.script.exec.join('\n')
      : event.script.exec;
    if (event.listen === 'test') draft.tests = script;
    if (event.listen === 'prerequest') draft.prerequest = script;
  }
  return draft;
}
/** Body modes edited in the request editor; others are kept unchanged. */
export const editableBodyModes = ['none', 'raw', 'urlencoded', 'formdata', 'file'];
/** A form row as Postman stores it: files by name only, never their content. */
function storedFormRow(x: KeyValue, mode: string) {
  const row: Record<string, unknown> = { key: x.key };
  if (mode === 'formdata' && x.type === 'file') {
    const names = fileNames(x);
    row['type'] = 'file';
    row['src'] = Array.isArray(x.src) ? names : (names[0] ?? null);
  } else {
    row['value'] = x.value;
    row['type'] = 'text';
  }
  if (mode === 'formdata' && x.contentType) row['contentType'] = x.contentType;
  row['disabled'] = !x.enabled;
  return row;
}
/**
 * The files a request sends, in the order the engine matches them to their names: each
 * enabled file row of a form-data body, then a binary body. Files not chosen again after
 * opening a saved request are left out, and the engine reports them.
 */
export function requestFiles(draft: RequestDraft): FileUpload[] {
  const chosen: AttachedFile[] = [];
  const names: string[] = [];
  if (draft.protocol !== 'graphql' && draft.bodyMode === 'formdata')
    for (const row of draft.form)
      if (row.enabled && row.key && row.type === 'file') {
        const files = row.files ?? [];
        fileNames(row).forEach((name, index) => {
          if (files[index]) {
            names.push(name);
            chosen.push(files[index]);
          }
        });
      }
  if (draft.protocol !== 'graphql' && draft.bodyMode === 'file' && draft.bodyFile?.file) {
    names.push(draft.bodyFile.src);
    chosen.push(draft.bodyFile.file);
  }
  if (chosen.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_FILES)
    throw new Error('Files sent with a request can add up to 32 MB');
  return chosen.map((file, index) => ({
    src: names[index],
    content: file.content,
    ...(file.contentType ? { contentType: file.contentType } : {}),
  }));
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
  const auth = writeAuth(draft.auth);
  // As Postman stores them: the URL as an object with the values of its `:name` segments.
  const variable = pathVariableRows(draft.url, draft.pathVariables ?? []).map((x) => ({
    key: x.key,
    value: x.value,
  }));
  const previous = typeof existing?.request === 'object' ? existing.request : {};
  const previousBody = previous['body'] as Record<string, unknown> | undefined;
  const body =
    draft.protocol === 'graphql'
      ? { mode: 'graphql', graphql: { query: draft.body, variables: draft.graphqlVariables } }
      : draft.bodyMode === 'raw'
        ? { mode: 'raw', raw: draft.body, options: { raw: { language: draft.bodyLanguage } } }
        : draft.bodyMode === 'none'
          ? { mode: 'none' }
          : draft.bodyMode === 'file'
            ? // Postman's binary body: the file by name only.
              { mode: 'file', file: { src: draft.bodyFile?.src ?? '' } }
            : !editableBodyModes.includes(draft.bodyMode) &&
                previousBody?.['mode'] === draft.bodyMode
              ? // A body Nexo cannot edit is kept as it was.
                previousBody
              : {
                  mode: draft.bodyMode,
                  [draft.bodyMode]: draft.form
                    .filter((x) => x.key)
                    .map((x) => storedFormRow(x, draft.bodyMode)),
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
      ...previous,
      method: draft.method,
      url: variable.length ? { raw: url, variable } : url,
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
