import { describe, expect, it } from 'vitest';
import { fileNames, fromItem, newRequest, toItem, updateItem } from './models/items';
import type { CollectionItem } from './models';
import { collectionDocs, reportRequest, reportResponse, reportText, runReport } from './reports';
import {
  applyScriptValues,
  previewText,
  requestAncestors,
  requestVariables,
  resolveVariables,
  scopeValues,
  toVariableRows,
} from './variables';
import { QuerySyntaxError, shellToExtendedJson } from './mongo-query';

describe('collection items, at their edges', () => {
  it('reads a sparse stored item: a bare URL, values missing and a GraphQL body without a query', () => {
    const draft = fromItem(
      {
        name: 'r',
        request: {
          url: { raw: 'https://x.test/:id', variable: [{ key: 'id' }, null, { value: 'no key' }] },
          header: [{ key: 'A' }],
          body: { mode: 'graphql' },
        },
        nexoDisabledQuery: [{ key: 'q' }],
        event: [{ listen: 'test', script: { exec: 'pm.test()' } }],
      } as unknown as CollectionItem,
      'id',
    );
    expect(draft.pathVariables).toEqual([{ key: 'id', value: '', enabled: true }]);
    expect(draft.headers).toEqual([{ key: 'A', value: '', enabled: true }]);
    expect(draft.query).toEqual([{ key: 'q', value: '', enabled: false }]);
    expect(draft).toMatchObject({
      protocol: 'graphql',
      body: '',
      graphqlVariables: '{}',
      tests: 'pm.test()',
    });
    const bare = fromItem({ name: 'b', request: 'https://y.test' } as CollectionItem, 'b');
    expect(bare.url).toBe('https://y.test');
    const noRequest = fromItem({ name: 'n' } as CollectionItem, 'n');
    expect(noRequest.method).toBe('GET');
    const file = fromItem(
      { name: 'f', request: { body: { mode: 'file', file: {} } } } as unknown as CollectionItem,
      'f',
    );
    expect(file.bodyFile).toEqual({ src: '' });
    const modeless = fromItem(
      { name: 'm', request: { body: { raw: 'x' } } } as unknown as CollectionItem,
      'm',
    );
    expect(modeless.bodyMode).toBe('raw');
  });

  it('writes a query after a URL that has one, and keeps a body mode it does not edit', () => {
    const draft = {
      ...newRequest('r'),
      url: 'https://x.test/a?b=1',
      query: [{ key: 'c', value: '2', enabled: true }],
    };
    expect(JSON.stringify(toItem(draft).request)).toContain('https://x.test/a?b=1&c=2');
    const existing = {
      id: 'r',
      name: 'r',
      request: { body: { mode: 'binary', binary: 'x' } },
    } as unknown as CollectionItem;
    const kept = toItem({ ...newRequest('r'), bodyMode: 'binary' }, existing);
    expect((kept.request as { body: unknown }).body).toEqual({ mode: 'binary', binary: 'x' });
    const file = toItem({ ...newRequest('r'), bodyMode: 'file', bodyFile: undefined });
    expect((file.request as { body: unknown }).body).toEqual({ mode: 'file', file: { src: '' } });
    expect(fileNames({ key: 'f', value: '', enabled: true, type: 'file' })).toEqual([]);
  });

  it('adds an item at the end of a collection when the path names no place', () => {
    const collection = { info: { name: 'c' }, item: [{ name: 'a' }] } as never;
    const updated = updateItem(collection, [], { name: 'b' } as CollectionItem);
    expect(updated.item.map((item) => item.name)).toEqual(['a', 'b']);
  });
});

describe('reports, at their edges', () => {
  it('writes requests and responses with what is missing left empty', () => {
    expect(reportText(undefined as unknown as string)).toEqual({ text: '', cut: false });
    const request = reportRequest({
      ...newRequest('r'),
      bodyMode: 'formdata',
      form: [{ key: 'up', value: '', enabled: true, type: 'file' }],
    });
    expect(JSON.stringify(request)).toContain('(file)');
    const file = reportRequest({ ...newRequest('r'), bodyMode: 'file', bodyFile: undefined });
    expect(JSON.stringify(file)).toContain('(file)');
    const response = reportResponse({
      status: 200,
      statusText: 'OK',
      time: 1,
      size: 0,
      body: '',
    } as never);
    expect(response).toMatchObject({ headers: [], assertions: [] });
  });

  it('writes a run without assertions, and the docs of a sparse collection', () => {
    const report = runReport(
      { id: 'r', results: [{ name: 'a', iteration: undefined }], iterations: 1 } as never,
      'C',
    );
    expect(report).toBeDefined();
    const docs = collectionDocs({
      item: [
        {
          name: 'x',
          item: undefined,
          request: { url: 'u', body: { mode: 'urlencoded', urlencoded: [{ key: 'k' }] } },
          response: [{}],
        },
      ],
    } as never);
    expect(docs.name).toBe('');
  });
});

describe('variables, at their edges', () => {
  it('reads rows defensively and resolves at most a few levels deep', () => {
    expect(toVariableRows([null, 'x', { key: 'a', value: null }])).toEqual([
      expect.objectContaining({ key: 'a', value: '' }),
    ]);
    const deep = {
      environment: [{ key: 'a', value: '{{a}}', enabled: true, secret: false }],
      collection: [],
      globals: [],
    };
    expect(resolveVariables('{{a}}', deep)).toBe('{{a}}');
    expect(previewText('{{a}}', deep)).toContain('a');
  });

  it('names the variables of a form body and of GraphQL', () => {
    const form = {
      ...newRequest('r'),
      bodyMode: 'urlencoded',
      form: [{ key: '{{k}}', value: '{{v}}', enabled: true }],
    };
    expect(requestVariables(form)).toEqual(expect.arrayContaining(['k', 'v']));
    const graphql = {
      ...newRequest('r'),
      protocol: 'graphql' as const,
      graphqlVariables: '{"a":"{{g}}"}',
    };
    expect(requestVariables(graphql)).toContain('g');
  });

  it('applies script values, adding and replacing rows', () => {
    const rows = applyScriptValues(
      [
        { key: 'a', value: '1', enabled: false, secret: false },
        { key: 'a', value: '2', enabled: false, secret: false },
      ],
      { a: { x: 1 }, b: null, '': 'skip' },
    );
    expect(rows?.filter((row) => row.key === 'a').map((row) => row.value)).toEqual([
      '1',
      '{"x":1}',
    ]);
    expect(rows?.find((row) => row.key === 'b')?.value).toBe('');
    expect(scopeValues(['not', 'a', 'row'])).toEqual({});
    expect(scopeValues({ values: [{ key: 'k', value: 1 }] })).toEqual({ k: 1 });
    expect(scopeValues('nothing')).toBeUndefined();
  });

  it('finds the ancestors of a request, stopping where a folder has no items', () => {
    const collection = { id: 'c', name: 'c', value: { item: [{ name: 'f' }] } };
    expect(requestAncestors(collection as never, [0, 0]).length).toBeGreaterThanOrEqual(1);
    expect(requestAncestors({ id: 'c', name: 'c', value: {} } as never, [])[0]).toMatchObject({
      name: 'Collection',
    });
  });
});

describe('the shell syntax reader, at its edges', () => {
  it.each([
    ['{a: 1', 'The text ends too soon'],
    ['{a: 1 b}', 'Unexpected character'],
    ['[1, 2', 'The text ends too soon'],
    ['{a: ObjectId("x"', 'The text ends too soon'],
    ['{a: -x}', 'Invalid number'],
    ['{a: /unclosed', 'Unclosed regular expression'],
    ['{a: ObjectId("bad")}', 'An ObjectId'],
    ['{a: 1} x', 'Unexpected character'],
  ])('refuses %s', (source, message) => {
    expect(() => shellToExtendedJson(source)).toThrow(QuerySyntaxError);
    expect(() => shellToExtendedJson(source)).toThrow(message);
  });

  it('reads comments and regular expressions with a class and an escaped slash', () => {
    expect(shellToExtendedJson(String.raw`/* c */ {a: /x\/y/i, b: /[/]x/} // note`)).toEqual({
      a: { $regularExpression: { pattern: 'x/y', options: 'i' } },
      b: { $regularExpression: { pattern: '[/]x', options: '' } },
    });
  });
});
