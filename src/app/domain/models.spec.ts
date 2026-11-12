import {
  asCollection,
  encodeQueryPart,
  fromItem,
  mergeRun,
  newRequest,
  Run,
  schema,
  toItem,
  updateItem,
} from './models';

describe('Collection editing', () => {
  it('preserves examples and unknown item metadata while editing a request', () => {
    const item = {
      name: 'Original',
      request: { method: 'GET', url: 'https://example.test', description: 'Keep this' },
      response: [{ name: 'Example' }],
      custom: { enabled: true },
    };
    const request = fromItem(item, 'id');
    request.name = 'Updated';
    const saved = toItem(request, item);
    expect(saved['response']).toEqual(item.response);
    expect(saved['custom']).toEqual(item.custom);
    expect((saved.request as Record<string, unknown>)['description']).toBe('Keep this');
  });
  it('updates nested folder requests without mutating the original collection', () => {
    const source = {
      info: { name: 'Fixture', schema },
      item: [
        {
          name: 'Folder',
          item: [{ name: 'Old', request: { method: 'GET', url: 'https://example.test' } }],
        },
      ],
    };
    const next = updateItem(source, [0, 0], { name: 'Changed' });
    expect(source.item[0].item[0].name).toBe('Old');
    expect(next.item[0].item?.[0].name).toBe('Changed');
  });
  it('represents disabled headers and test scripts in the portable format', () => {
    const request = newRequest('a');
    request.headers = [{ key: 'X-Disabled', value: 'x', enabled: false }];
    request.tests = 'pm.test("status",()=>{});';
    const item = toItem(request);
    expect((item.request as Record<string, unknown>)['header']).toEqual([
      { key: 'X-Disabled', value: 'x', disabled: true },
    ]);
    expect(item.event?.[1].script.exec).toEqual([request.tests]);
  });
  it('rejects invalid collections at the domain boundary', () => {
    expect(() => asCollection({ info: {} })).toThrow('Invalid collection');
  });
});

describe('query parameters', () => {
  it('keep variable placeholders while encoding the rest', () => {
    expect(encodeQueryPart('{{tenant}}')).toBe('{{tenant}}');
    expect(encodeQueryPart('a b&{{x}}')).toBe('a%20b%26{{x}}');
  });
});

describe('incremental runs', () => {
  it('appends only the entries received after the cursor', () => {
    const first = {
      id: 'r',
      state: 'running',
      results: [{ status: 200 }],
      assertions: [],
      logs: ['a'],
      counts: { results: 1, assertions: 0, logs: 1 },
    } as unknown as Run;
    const update = {
      id: 'r',
      state: 'completed',
      results: [{ status: 201 }],
      assertions: [{ name: 't', passed: true }],
      logs: [],
      counts: { results: 2, assertions: 1, logs: 1 },
    } as unknown as Run;
    const merged = mergeRun(first, update);
    expect(merged.results.map((r) => r.status)).toEqual([200, 201]);
    expect(merged.logs).toEqual(['a']);
    expect(merged.state).toBe('completed');
    expect(merged.counts).toEqual({ results: 2, assertions: 1, logs: 1 });
  });
});
