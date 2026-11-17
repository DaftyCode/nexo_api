import { describe, expect, it } from 'vitest';
import { authDetails, emptyAuth, inheritedAuth, readAuth, writeAuth } from './auth';
import { mcpView, parseGitStatus, tokenView } from './integration-views';
import { exportName, formatOf, transferValue } from './mongo-transfer';

describe('integration views, at their edges', () => {
  it('reads every kind of git status line', () => {
    const status = parseGitStatus(
      [
        '# branch.head main',
        '# branch.ab +x -y',
        '1 .D N... 100644 100644 000000 abc abc src/gone.ts',
        '2 R. N... 100644 100644 100644 abc abc R100 new.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 a b c both.ts',
        '1 .. N... 100644 100644 100644 abc abc same.ts',
        '1 X. N... 100644 100644 100644 abc abc odd.ts',
      ].join('\n'),
    );
    expect(status).toMatchObject({ branch: 'main', ahead: 0, behind: 0 });
    expect(status.files.map((file) => [file.path, file.change])).toEqual([
      ['src/gone.ts', 'deleted'],
      ['new.ts', 'renamed'],
      ['both.ts', 'conflict'],
      ['same.ts', 'modified'],
      ['odd.ts', 'modified'],
    ]);
  });

  it('reads embedded resources, binaries, prompt messages and errors of MCP', () => {
    const view = mcpView({
      status: 200,
      result: [
        {
          result: {
            content: [
              { type: 'resource', resource: { blob: 'AA==', uri: 'file:///a' } },
              { type: 'text' },
            ],
            contents: [{ uri: 'u', blob: 'AA==' }],
            messages: [
              { role: 'user', content: { type: 'resource', resource: { text: 'hi', uri: 'r' } } },
              { role: 'x' },
            ],
          },
        },
        { error: { message: 'boom' } },
      ],
    });
    expect(view.texts).toEqual(['(binary)']);
    expect(view.contents[0].text).toBe('(binary)');
    expect(view.messages).toEqual([
      { role: 'user', text: 'hi', uri: 'r' },
      { role: 'x', text: '' },
    ]);
    expect(view.error).toBe('boom');
    expect(mcpView(undefined).status).toBe(0);
    expect(tokenView({ status: 400, body: undefined as never }).fields).toEqual([]);
  });
});

describe('MongoDB transfers stored, at their edges', () => {
  it('reads a stored transfer with wrong and missing values', () => {
    const value = transferValue({
      columns: [{}, 'x'],
      query: 'nope',
      to: null,
      continueOnError: false,
    });
    expect(value.columns).toEqual([{ column: '', field: '', type: 'auto' }]);
    expect(value.continueOnError).toBe(false);
    expect(transferValue(null).direction).toBe('export');
  });

  it('guesses the format of a file and names an export', () => {
    expect(formatOf('a.JSON')).toBe('json');
    expect(formatOf('a.tsv')).toBe('csv');
    expect(formatOf('a.ndjson')).toBe('jsonl');
    expect(formatOf('data', '[')).toBe('json');
    expect(formatOf('data', 'a')).toBe('csv');
    expect(formatOf('')).toBe('csv');
    expect(exportName('***', 'csv', new Date('2026-01-02T00:00:00Z'))).toBe('_-2026-01-02.csv');
    expect(exportName('', 'json', new Date('2026-01-02T00:00:00Z'))).toBe('export-2026-01-02.json');
  });
});

describe('authorizations, at their edges', () => {
  it('reads stored values that are not quite right', () => {
    const auth = readAuth({ type: undefined, noauth: [null, { key: 1 }, { key: 'token' }] });
    expect(auth.type).toBe('noauth');
    const bearer = readAuth({ type: 'bearer', bearer: [{ key: 'token' }] });
    expect(bearer.token).toBe('');
    expect(() => writeAuth({ ...emptyAuth('oauth2'), parameters: '' })).not.toThrow();
  });

  it('describes values that are not texts, and finds the auth of the nearest folder', () => {
    const details = authDetails({
      ...emptyAuth('oauth2'),
      values: { scope: ['a'], none: undefined } as unknown as Record<string, string>,
    });
    expect(details).toEqual([
      { key: 'scope', value: '["a"]', secret: false },
      { key: 'none', value: '""', secret: false },
    ]);
    const collection = {
      info: undefined,
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] },
      item: [{ name: 'f', item: [{ name: 'g' }] }],
    } as never;
    expect(inheritedAuth(collection, [0, 0])?.name).toBe('Collection');
    expect(inheritedAuth(collection, [3, 0, 0])?.name).toBe('Collection');
  });
});
