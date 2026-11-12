/** Requests as collection items (Postman format) and back, and the items of a collection. */

import {
  type AttachedFile,
  type FileUpload,
  type KeyValue,
  MAX_REQUEST_FILES,
  readRealtime,
  type RequestDraft,
  storedRealtime,
} from './requests';
import { encodeQueryPart, pathVariableRows, row, splitQuery } from './query-string';
import { emptyAuth, readAuth, writeAuth } from '../auth';
import type { Collection, CollectionItem } from './workspace';

export const schema = 'urn:nexo:collection:1';

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
