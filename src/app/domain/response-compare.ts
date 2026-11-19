/**
 * Comparing two responses: where each one comes from (a tab, the history, a collection run
 * or sending the request of the tab with an environment), what the backend is given of each
 * and what it answers changed.
 */
import { ExecutionResponse, Run } from './models';

/** Characters of each body compared at most; a longer body is compared up to there. */
export const COMPARE_BODY_LIMIT = 2 * 1024 * 1024;

/** Where one of the compared responses comes from. */
export type ResponseSource =
  | { kind: 'tab'; tab: string }
  | { kind: 'history'; id: string }
  | { kind: 'run'; id: string; index: number }
  /** The request of the active tab, sent with an environment (`''`: none). */
  | { kind: 'send'; environment: string };
export type ResponseSourceKind = ResponseSource['kind'];

/** A response as the backend compares it: without timings, tests or logs. */
export interface ComparedSide {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  body: string;
  bodyEncoding?: string;
  truncated?: boolean;
  error?: string;
}

/** A field, header or item whose value differs; the side that lacks it has no value. */
export interface FieldDifference {
  path: string;
  source?: unknown;
  target?: unknown;
}
export type DifferenceKind = 'added' | 'removed' | 'changed';

export interface HeaderDifference {
  name: string;
  source?: string;
  target?: string;
}

export interface StatusSide {
  status: number;
  statusText: string;
  error?: string;
}

/** What the backend says changed from one response to the other. */
export interface ResponseComparison {
  same: boolean;
  status: { same: boolean; source: StatusSide; target: StatusSide };
  headers: HeaderDifference[];
  body: {
    format: 'json' | 'text' | 'binary';
    same: boolean;
    /** A body was cut: by the history, a run or the limit of the comparison. */
    cut: boolean;
    /** JSON bodies: the fields that differ, at most a thousand. */
    differences?: FieldDifference[];
    /** Whether `differences` are all of them. */
    complete?: boolean;
    /** The bodies as they are shown side by side (JSON ones with their fields sorted). */
    source?: string;
    target?: string;
  };
}

/** What changed in a field: it is only in the second response, only in the first, or both. */
export function differenceKind(difference: { source?: unknown; target?: unknown }) {
  if (difference.source === undefined) return 'added';
  if (difference.target === undefined) return 'removed';
  return 'changed';
}

/** A response as it is sent to compare: a body longer than the limit is cut there. */
export function comparedSide(response: ExecutionResponse): ComparedSide {
  const body = response.body ?? '';
  const cut = body.length > COMPARE_BODY_LIMIT;
  return {
    status: response.status ?? 0,
    statusText: response.statusText ?? '',
    headers: (response.headers ?? []).map(({ key, value }) => ({
      key: String(key),
      value: String(value ?? ''),
    })),
    body: cut ? body.slice(0, COMPARE_BODY_LIMIT) : body,
    ...(response.bodyEncoding ? { bodyEncoding: response.bodyEncoding } : {}),
    ...(cut || response.truncated ? { truncated: true } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
}

/** Paths or headers typed separated by commas or lines, each once. */
export function ignoreList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

/** A value of a difference in one line: text as it is, the rest as JSON. */
export function valueText(value: unknown, limit = 200): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One response of a collection run, to choose it. */
export interface RunResult {
  index: number;
  name: string;
  /** From 1. */
  iteration: number;
  status: number;
}

/** The responses of a run, in the order they were sent. */
export function runResults(run: Pick<Run, 'results'> | undefined): RunResult[] {
  return (run?.results ?? []).map((result, index) => {
    const named = result as ExecutionResponse & { name?: unknown; iteration?: unknown };
    return {
      index,
      name: typeof named.name === 'string' && named.name ? named.name : `#${index + 1}`,
      iteration: (typeof named.iteration === 'number' ? named.iteration : 0) + 1,
      status: result.status ?? 0,
    };
  });
}

/** One side as its form edits it: every choice is kept, and `kind` says which one counts. */
export interface CompareSideForm {
  kind: ResponseSourceKind;
  tab: string;
  history: string;
  run: string;
  /** The index of the response in the run, as the select gives it. */
  result: string;
  environment: string;
}

export function sideForm(source: ResponseSource = { kind: 'send', environment: '' }) {
  const side: CompareSideForm = {
    kind: source.kind,
    tab: '',
    history: '',
    run: '',
    result: '0',
    environment: '',
  };
  switch (source.kind) {
    case 'tab':
      return { ...side, tab: source.tab };
    case 'history':
      return { ...side, history: source.id };
    case 'run':
      return { ...side, run: source.id, result: String(source.index) };
    case 'send':
      return { ...side, environment: source.environment };
  }
}

export function sourceOf(side: CompareSideForm): ResponseSource {
  switch (side.kind) {
    case 'tab':
      return { kind: 'tab', tab: side.tab };
    case 'history':
      return { kind: 'history', id: side.history };
    case 'run':
      return { kind: 'run', id: side.run, index: Math.max(Number(side.result) || 0, 0) };
    case 'send':
      return { kind: 'send', environment: side.environment };
  }
}
