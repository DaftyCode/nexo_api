import { ExecutionResponse } from './models';
import {
  COMPARE_BODY_LIMIT,
  comparedSide,
  differenceKind,
  ignoreList,
  runResults,
  sideForm,
  sourceOf,
  valueText,
} from './response-compare';

const response = (body: string, extra: Partial<ExecutionResponse> = {}): ExecutionResponse => ({
  status: 200,
  statusText: 'OK',
  body,
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
  time: 12,
  size: body.length,
  assertions: [{ name: 't', passed: true, skipped: false }],
  logs: [],
  ...extra,
});

describe('response comparison', () => {
  it('sends only what is compared, and a long body cut at the limit', () => {
    expect(comparedSide(response('{"a":1}'))).toEqual({
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{"a":1}',
    });
    const long = comparedSide(response('x'.repeat(COMPARE_BODY_LIMIT + 1)));
    expect(long.body.length).toBe(COMPARE_BODY_LIMIT);
    expect(long.truncated).toBe(true);
    const failed = comparedSide({
      ...response('', { error: 'refused', bodyEncoding: 'base64', truncated: true }),
      status: undefined as unknown as number,
      statusText: undefined as unknown as string,
      body: undefined as unknown as string,
      headers: undefined as unknown as [],
    });
    expect(failed).toEqual({
      status: 0,
      statusText: '',
      headers: [],
      body: '',
      bodyEncoding: 'base64',
      truncated: true,
      error: 'refused',
    });
  });

  it('tells what changed in a field', () => {
    expect(differenceKind({ target: 1 })).toBe('added');
    expect(differenceKind({ source: 1 })).toBe('removed');
    expect(differenceKind({ source: null, target: 1 })).toBe('changed');
  });

  it('reads the paths to leave out, each once', () => {
    expect(ignoreList(' updatedAt, $.meta.id\nitems[*].id,,updatedAt ')).toEqual([
      'updatedAt',
      '$.meta.id',
      'items[*].id',
    ]);
    expect(ignoreList('')).toEqual([]);
  });

  it('shows values in one line, cut when long', () => {
    expect(valueText('text')).toBe('text');
    expect(valueText({ a: [1, null] })).toBe('{"a":[1,null]}');
    expect(valueText(null)).toBe('null');
    expect(valueText(undefined)).toBe('');
    expect(valueText('abcdef', 3)).toBe('abc…');
  });

  it('lists the responses of a run with their name and iteration', () => {
    const run = {
      results: [
        { ...response(''), name: 'Users', iteration: 0 },
        { ...response(''), status: 0 },
      ] as ExecutionResponse[],
    };
    expect(runResults(run)).toEqual([
      { index: 0, name: 'Users', iteration: 1, status: 200 },
      { index: 1, name: '#2', iteration: 1, status: 0 },
    ]);
    expect(runResults(undefined)).toEqual([]);
  });
});

describe('the form of a compared response', () => {
  it('keeps the choice of each kind and gives the one chosen', () => {
    const sources = [
      { kind: 'tab', tab: 't1' },
      { kind: 'history', id: 'h1' },
      { kind: 'run', id: 'r1', index: 2 },
      { kind: 'send', environment: 'e1' },
    ] as const;
    for (const source of sources) expect(sourceOf(sideForm(source))).toEqual(source);
    expect(sideForm()).toEqual({
      kind: 'send',
      tab: '',
      history: '',
      run: '',
      result: '0',
      environment: '',
    });
    expect(sourceOf({ ...sideForm(), kind: 'run', run: 'r', result: 'x' })).toEqual({
      kind: 'run',
      id: 'r',
      index: 0,
    });
  });
});
