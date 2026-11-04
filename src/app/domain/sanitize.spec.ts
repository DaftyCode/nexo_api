import { exportableCollection, historyRequest, historyResponse, masked } from './sanitize';
import { newRequest, ExecutionResponse } from './models';

describe('sanitize', () => {
  it('removes credentials from history requests and keeps variable references', () => {
    const request = newRequest('r');
    request.headers = [
      { key: 'Authorization', value: 'Bearer abc', enabled: true },
      { key: 'X-Token', value: '{{token}}', enabled: true },
      { key: 'Accept', value: 'application/json', enabled: true },
    ];
    request.auth = { ...request.auth, type: 'basic', username: 'ada', password: 'hunter2' };
    request.transport = '{"clientTls":{"keyPem":"PRIVATE"}}';
    const saved = historyRequest(request);
    expect(saved.headers.map((h) => h.value)).toEqual([masked, '{{token}}', 'application/json']);
    expect(saved.auth.password).toBe(masked);
    expect(saved.auth.username).toBe('ada');
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    expect(JSON.stringify(saved)).not.toContain('PRIVATE');
    const placeholders = historyRequest({
      ...request,
      auth: { ...request.auth, password: '{{pw}}' },
    });
    expect(placeholders.auth.password).toBe('{{pw}}');
  });

  it('truncates large bodies and hides cookies in history responses', () => {
    const response = {
      status: 200,
      body: 'x'.repeat(20),
      headers: [{ key: 'set-cookie', value: 'session=1', enabled: true }],
      variables: { environment: {} },
    } as unknown as ExecutionResponse;
    const saved = historyResponse(response, 10);
    expect(saved.body).toHaveLength(10);
    expect(saved.truncated).toBe(true);
    expect(saved.headers[0].value).toBe(masked);
    expect('variables' in saved).toBe(false);
  });

  it('prepares collections for Git without literal secrets', () => {
    const exported = exportableCollection({
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'live-token' }] },
      item: [
        {
          name: 'r',
          nexoTransport: '{"clientTls":{}}',
          request: {
            auth: {
              type: 'basic',
              basic: [
                { key: 'username', value: 'ada' },
                { key: 'password', value: '{{password}}' },
              ],
            },
          },
        },
      ],
    }) as Record<string, never>;
    const text = JSON.stringify(exported);
    expect(text).not.toContain('live-token');
    expect(text).not.toContain('nexoTransport');
    expect(text).toContain('{{password}}');
    expect(text).toContain('ada');
  });
});
