import { asCollection, fromItem, toItem, updateItem, newRequest, schema } from './models';
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
