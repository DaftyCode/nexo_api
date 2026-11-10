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
      resources: [],
      prompts: [],
      contents: [],
      messages: [],
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
  it('reads MCP resources, templates, prompts, read contents and prompt messages', () => {
    const view = mcpView({
      status: 200,
      result: [
        {
          result: {
            resources: [
              { uri: 'nexo://a', name: 'A', title: 'Title A', mimeType: 'application/json' },
              { uri: 'file:///b', name: 'B', description: 'Second' },
            ],
            resourceTemplates: [{ uriTemplate: 'nexo://{id}', name: 'By id' }],
          },
        },
        {
          result: {
            prompts: [
              {
                name: 'review',
                title: 'Review code',
                arguments: [
                  { name: 'code', description: 'Code', required: true },
                  { name: 'tone' },
                ],
              },
              'not a prompt',
            ],
          },
        },
        {
          result: {
            contents: [
              { uri: 'nexo://a', mimeType: 'text/plain', text: 'hello' },
              { uri: 'nexo://img', blob: 'AAAA' },
            ],
          },
        },
        {
          result: {
            messages: [
              { role: 'user', content: { type: 'text', text: 'Do it' } },
              {
                role: 'user',
                content: { type: 'resource', resource: { uri: 'nexo://a', text: '{}' } },
              },
              { role: 'assistant', content: { type: 'resource', resource: { blob: 'AA' } } },
              { role: 'user', content: { type: 'image', data: 'AA' } },
            ],
            content: [{ type: 'resource', resource: { uri: 'nexo://c', text: 'embedded' } }],
          },
        },
      ],
    });
    expect(view.resources).toEqual([
      {
        uri: 'nexo://a',
        name: 'Title A',
        description: '',
        mimeType: 'application/json',
        template: false,
      },
      { uri: 'file:///b', name: 'B', description: 'Second', mimeType: '', template: false },
      { uri: 'nexo://{id}', name: 'By id', description: '', mimeType: '', template: true },
    ]);
    expect(view.prompts).toEqual([
      {
        name: 'review',
        description: 'Review code',
        arguments: [
          { name: 'code', description: 'Code', required: true },
          { name: 'tone', description: '', required: false },
        ],
      },
    ]);
    expect(view.contents).toEqual([
      { uri: 'nexo://a', mimeType: 'text/plain', text: 'hello' },
      { uri: 'nexo://img', mimeType: '', text: '(binary)' },
    ]);
    expect(view.messages).toEqual([
      { role: 'user', text: 'Do it' },
      { role: 'user', text: '{}', uri: 'nexo://a' },
      { role: 'assistant', text: '(binary)' },
      { role: 'user', text: '' },
    ]);
    expect(view.texts).toEqual(['embedded']);
    expect(mcpView(undefined)).toMatchObject({ status: 0, tools: [] });
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
