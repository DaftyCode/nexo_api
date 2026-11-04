import { mcpView, parseGitStatus, tokenView } from './integration-views';

describe('integration views', () => {
  it('parses Git porcelain v2 status', () => {
    const status = parseGitStatus(
      [
        '# branch.oid 1234',
        '# branch.head main',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 aaa bbb api.json',
        '1 A. N... 000000 100644 100644 000 ccc new file.json',
        '2 R. N... 100644 100644 100644 ddd eee R100 renamed.json\told.json',
        '? notes.txt',
      ].join('\n'),
    );
    expect(status).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'api.json', change: 'modified' },
        { path: 'new file.json', change: 'added' },
        { path: 'renamed.json', change: 'renamed' },
        { path: 'notes.txt', change: 'untracked' },
      ],
    });
  });
  it('reads MCP tools, text content and errors from JSON or SSE answers', () => {
    expect(
      mcpView({
        status: 200,
        sessionId: 's1',
        result: { result: { tools: [{ name: 'echo', description: 'Echoes' }] } },
      }),
    ).toEqual({
      status: 200,
      session: 's1',
      tools: [{ name: 'echo', description: 'Echoes' }],
      texts: [],
    });
    const sse = mcpView({
      status: 200,
      result: [
        { result: { content: [{ type: 'text', text: 'hi' }] } },
        { error: { message: 'bad' } },
      ],
    });
    expect(sse.texts).toEqual(['hi']);
    expect(sse.error).toBe('bad');
  });
  it('shortens credentials in token responses', () => {
    const view = tokenView({
      status: 200,
      body: { access_token: 'abcdefghijklmnopqrstuvwxyz', token_type: 'Bearer', expires_in: 3600 },
    });
    expect(view.fields).toEqual([
      { key: 'access_token', value: 'abcdef…wxyz' },
      { key: 'token_type', value: 'Bearer' },
      { key: 'expires_in', value: '3600' },
    ]);
  });
});
