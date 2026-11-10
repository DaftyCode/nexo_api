import {
  Assertion,
  Collection,
  CollectionItem,
  ExecutionResponse,
  KeyValue,
  RequestDraft,
  Run,
  fromItem,
} from './models';
import { historyRequest, historyResponse, masked } from './sanitize';
import { isSensitive } from './variables';

/** Text longer than this is cut in a report, which stays readable on paper. */
export const REPORT_TEXT_LIMIT = 64 * 1024;

/** A body or a script for a report: pretty JSON when it is JSON, and cut when too long. */
export function reportText(text: string, limit = REPORT_TEXT_LIMIT) {
  let shown = text ?? '';
  try {
    const parsed: unknown = JSON.parse(shown);
    if (parsed && typeof parsed === 'object') shown = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON: as it is.
  }
  return shown.length > limit
    ? { text: shown.slice(0, limit), cut: true }
    : { text: shown, cut: false };
}

const enabled = (rows: readonly KeyValue[]) => rows.filter((row) => row.enabled && row.key);

/** A request as reports show it: credentials hidden as in the history. */
export interface ReportRequest {
  name: string;
  method: string;
  url: string;
  description: string;
  auth: string;
  headers: KeyValue[];
  query: KeyValue[];
  body: { text: string; cut: boolean };
  bodyMode: string;
}
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { content?: unknown }).content === 'string'
  )
    return (value as { content: string }).content;
  return '';
}
export function reportRequest(request: RequestDraft, description = ''): ReportRequest {
  const safe = historyRequest(request);
  const form = enabled(safe.form)
    .map(
      (row) =>
        `${row.key}: ${row.type === 'file' ? `(file) ${[row.src ?? []].flat().join(', ')}` : row.value}`,
    )
    .join('\n');
  const body =
    safe.bodyMode === 'formdata' || safe.bodyMode === 'urlencoded'
      ? form
      : safe.bodyMode === 'file'
        ? `(file) ${safe.bodyFile?.src ?? ''}`
        : safe.bodyMode === 'none'
          ? ''
          : safe.body;
  return {
    name: safe.name,
    method: safe.method,
    url: safe.url,
    description,
    auth: ['inherit', 'none', 'noauth'].includes(safe.auth.type) ? '' : safe.auth.type,
    headers: enabled(safe.headers),
    query: enabled(safe.query),
    body: reportText(body),
    bodyMode: body ? safe.bodyMode : '',
  };
}

/** A response as reports show it: credential headers hidden and a long body cut. */
export interface ReportResponse {
  status: number;
  statusText: string;
  time: number;
  size: number;
  error?: string;
  headers: KeyValue[];
  body: { text: string; cut: boolean };
  binary: boolean;
  assertions: Assertion[];
}
export function reportResponse(response: ExecutionResponse): ReportResponse {
  const safe = historyResponse(response);
  const binary = safe.bodyEncoding === 'base64';
  return {
    status: safe.status,
    statusText: safe.statusText,
    time: safe.time,
    size: safe.size,
    ...(safe.error ? { error: safe.error } : {}),
    headers: safe.headers ?? [],
    body: binary ? { text: '', cut: false } : reportText(safe.body),
    binary,
    assertions: safe.assertions ?? [],
  };
}

/** One request and its response. */
export interface RequestReport {
  request: ReportRequest;
  response: ReportResponse;
}
export function requestReport(request: RequestDraft, response: ExecutionResponse): RequestReport {
  return { request: reportRequest(request), response: reportResponse(response) };
}

/** A collection run: totals, then each request with its tests. */
export interface RunReport {
  collection: string;
  state: string;
  error?: string;
  duration: number;
  totals: {
    requests: number;
    failedRequests: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  requests: {
    name: string;
    method: string;
    url: string;
    iteration: number;
    status: number;
    statusText: string;
    time: number;
    error?: string;
    failed: boolean;
    assertions: Assertion[];
  }[];
  /** Tests that cannot be placed under a request, such as those of older runs. */
  other: Assertion[];
}
export function runReport(run: Run, collection: string): RunReport {
  const assertions = run.assertions ?? [];
  const used = new Set<Assertion>();
  const requests = run.results.map((result) => {
    const sent = (result.request ?? {}) as { method?: unknown; url?: unknown };
    const extra = result as ExecutionResponse & { name?: string; iteration?: number };
    const name = extra.name ?? '';
    const iteration = extra.iteration ?? 0;
    const own = assertions.filter(
      (assertion) =>
        !used.has(assertion) &&
        assertion.request === name &&
        (assertion.iteration ?? 0) === iteration,
    );
    own.forEach((assertion) => used.add(assertion));
    return {
      name,
      method: typeof sent.method === 'string' ? sent.method : '',
      url: typeof sent.url === 'string' ? sent.url : '',
      iteration,
      status: result.status,
      statusText: result.statusText,
      time: result.time,
      ...(result.error ? { error: result.error } : {}),
      failed: !!result.error || result.status >= 400 || own.some((a) => !a.passed),
      assertions: own,
    };
  });
  const counted = assertions.filter((assertion) => !assertion.skipped);
  return {
    collection,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    duration: run.duration ?? 0,
    totals: {
      requests: requests.length,
      failedRequests: requests.filter((request) => request.failed).length,
      passed: counted.filter((assertion) => assertion.passed).length,
      failed: counted.filter((assertion) => !assertion.passed).length,
      skipped: assertions.length - counted.length,
    },
    requests,
    other: assertions.filter((assertion) => !used.has(assertion)),
  };
}

/** A folder or request of a collection's documentation, in reading order. */
export interface DocEntry {
  kind: 'folder' | 'request';
  depth: number;
  name: string;
  description: string;
  request?: ReportRequest;
  examples: { name: string; status: string; body: { text: string; cut: boolean } }[];
}
/** The documentation of a collection: its variables with secrets hidden, then each entry. */
export interface CollectionDocs {
  name: string;
  description: string;
  auth: string;
  variables: KeyValue[];
  entries: DocEntry[];
  requests: number;
}
function examples(item: CollectionItem): DocEntry['examples'] {
  const responses = Array.isArray(item['response'])
    ? (item['response'] as Record<string, unknown>[])
    : [];
  return responses.map((example) => ({
    name: String(example['name'] ?? ''),
    status: [example['code'], example['status']]
      .filter((part) => part !== undefined && part !== '')
      .join(' '),
    body: reportText(typeof example['body'] === 'string' ? example['body'] : ''),
  }));
}
export function collectionDocs(collection: Collection): CollectionDocs {
  const entries: DocEntry[] = [];
  const visit = (items: readonly CollectionItem[], depth: number) => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        entries.push({
          kind: 'folder',
          depth,
          name: item.name,
          description: describe(item['description']),
          examples: [],
        });
        visit(item.item, depth + 1);
      } else if (item.request !== undefined) {
        const request = typeof item.request === 'object' ? item.request : {};
        entries.push({
          kind: 'request',
          depth,
          name: item.name,
          description: describe(request['description'] ?? item['description']),
          request: reportRequest(fromItem(item, item.id ?? item.name)),
          examples: examples(item),
        });
      }
    }
  };
  visit(collection.item ?? [], 0);
  const info = collection.info ?? { name: '' };
  const auth = (collection['auth'] ?? {}) as { type?: unknown };
  const variables = (Array.isArray(collection['variable']) ? collection['variable'] : []) as Record<
    string,
    unknown
  >[];
  return {
    name: String(info.name ?? ''),
    description: describe(info['description']),
    auth: typeof auth.type === 'string' && auth.type !== 'noauth' ? auth.type : '',
    variables: variables
      .filter((row) => typeof row['key'] === 'string' && row['key'])
      .map((row) => {
        const key = String(row['key']);
        const value = String(row['value'] ?? '');
        const secret = row['type'] === 'secret' || row['secret'] === true;
        return {
          key,
          value:
            isSensitive({ key, value, secret }) && !/^\s*\{\{[^{}]+\}\}\s*$/.test(value) && value
              ? masked
              : value,
          enabled: true,
        };
      }),
    entries,
    requests: entries.filter((entry) => entry.kind === 'request').length,
  };
}
