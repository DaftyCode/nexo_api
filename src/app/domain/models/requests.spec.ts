import { AttachedFile, fromItem, newRequest, requestFiles, toItem } from '../models';

describe('protocol requests in collections', () => {
  const settings = {
    protocol: 'grpc' as const,
    url: 'localhost:50051',
    message: '',
    grpcMessage: '{"name":"Nexo"}',
    topic: '',
    event: 'message',
    proto: 'syntax = "proto3"; service Greeter { rpc Hello (A) returns (B); }',
    service: 'demo.Greeter',
    method: 'Hello',
    metadata: '[]',
    tls: false,
    strictSSL: true,
    caPem: '',
    username: 'user',
    password: 'literal-secret',
    qos: '0',
    headers: [],
  };
  it('reopen with their proto, service and method, without literal passwords', () => {
    const draft = newRequest('g1');
    draft.realtime = settings;
    draft.protocol = 'grpc';
    const item = toItem(draft);
    expect(JSON.stringify(item)).not.toContain('literal-secret');
    const reopened = fromItem(item, 'g1');
    expect(reopened.protocol).toBe('grpc');
    expect(reopened.realtime).toMatchObject({
      proto: settings.proto,
      service: 'demo.Greeter',
      method: 'Hello',
      password: '',
    });
  });
  it('keep password references to variables', () => {
    const draft = newRequest('m1');
    draft.realtime = { ...settings, protocol: 'mqtt', password: '{{vault:mqtt}}' };
    expect(fromItem(toItem(draft), 'm1').realtime?.password).toBe('{{vault:mqtt}}');
  });
  it('reopen a saved GraphQL subscription with its operation and protocol', () => {
    const draft = newRequest('s1');
    draft.realtime = {
      ...settings,
      protocol: 'graphql-subscription',
      query: 'subscription { ticks }',
      variables: '{"from": 1}',
      connectionParams: '{"token": "{{token}}"}',
      graphqlProtocol: 'graphql-ws',
    };
    const reopened = fromItem(toItem(draft), 's1');
    expect(reopened.protocol).toBe('graphql-subscription');
    expect(reopened.realtime).toMatchObject({
      query: 'subscription { ticks }',
      variables: '{"from": 1}',
      connectionParams: '{"token": "{{token}}"}',
      graphqlProtocol: 'graphql-ws',
    });
  });
});

describe('Files sent with a request', () => {
  const attached = (name: string, size = 3): AttachedFile => ({
    name,
    contentType: 'image/png',
    size,
    content: 'AQID',
  });

  it('keeps Postman file fields and binary bodies by name only', () => {
    const item = {
      name: 'Upload',
      request: {
        method: 'POST',
        url: 'https://x.test',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'note', value: 'hi', type: 'text', contentType: 'text/plain' },
            { key: 'avatar', type: 'file', src: '/home/ana/avatar.png' },
            { key: 'docs', type: 'file', src: ['a.pdf', 'b.pdf'], disabled: true },
            { key: 'empty', type: 'file', src: null },
          ],
        },
      },
    };
    const draft = fromItem(item, 'u');
    expect(draft.form.map((row) => [row.key, row.type, row.src, row.contentType])).toEqual([
      ['note', undefined, undefined, 'text/plain'],
      ['avatar', 'file', '/home/ana/avatar.png', undefined],
      ['docs', 'file', ['a.pdf', 'b.pdf'], undefined],
      ['empty', 'file', '', undefined],
    ]);
    draft.form[1].files = [attached('avatar.png')];
    const saved = toItem(draft, item);
    const rows = (saved.request as { body: { formdata: unknown[] } }).body.formdata;
    expect(rows).toEqual([
      { key: 'note', value: 'hi', type: 'text', contentType: 'text/plain', disabled: false },
      { key: 'avatar', type: 'file', src: '/home/ana/avatar.png', disabled: false },
      { key: 'docs', type: 'file', src: ['a.pdf', 'b.pdf'], disabled: true },
      { key: 'empty', type: 'file', src: null, disabled: false },
    ]);
    expect(JSON.stringify(saved)).not.toContain('AQID');

    const binary = fromItem(
      {
        name: 'Put',
        request: { method: 'PUT', body: { mode: 'file', file: { src: 'data.bin' } } },
      },
      'b',
    );
    expect([binary.bodyMode, binary.bodyFile]).toEqual(['file', { src: 'data.bin' }]);
    binary.bodyFile = { src: 'data.bin', file: attached('data.bin') };
    expect((toItem(binary).request as { body: unknown }).body).toEqual({
      mode: 'file',
      file: { src: 'data.bin' },
    });
  });

  it('sends the files chosen, in the order of their fields, within the size limit', () => {
    const draft = newRequest('f');
    draft.bodyMode = 'formdata';
    draft.form = [
      {
        key: 'one',
        value: '',
        enabled: true,
        type: 'file',
        src: 'a.png',
        files: [attached('a.png')],
      },
      {
        key: 'off',
        value: '',
        enabled: false,
        type: 'file',
        src: 'x.png',
        files: [attached('x.png')],
      },
      {
        key: 'two',
        value: '',
        enabled: true,
        type: 'file',
        src: ['b.png', 'c.png'],
        files: [attached('b.png')],
      },
      { key: 'text', value: 'v', enabled: true },
    ];
    expect(requestFiles(draft)).toEqual([
      { src: 'a.png', content: 'AQID', contentType: 'image/png' },
      { src: 'b.png', content: 'AQID', contentType: 'image/png' },
    ]);
    draft.bodyMode = 'file';
    draft.bodyFile = { src: 'body.bin', file: { ...attached('body.bin'), contentType: '' } };
    expect(requestFiles(draft)).toEqual([{ src: 'body.bin', content: 'AQID' }]);
    draft.bodyFile = { src: 'body.bin', file: attached('body.bin', 33 * 1024 * 1024) };
    expect(() => requestFiles(draft)).toThrow('Files sent with a request can add up to 32 MB');
    draft.protocol = 'graphql';
    expect(requestFiles(draft)).toEqual([]);
  });
});
