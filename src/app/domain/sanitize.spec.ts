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

  it('removes OAuth 1.0 secrets and private keys from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'oauth1',
          oauth1: [
            { key: 'consumerKey', value: 'consumer' },
            { key: 'consumerSecret', value: 'consumer-secret' },
            { key: 'token', value: 'access-token' },
            { key: 'tokenSecret', value: '{{tokenSecret}}' },
            { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----' },
          ],
        },
      }),
    );
    expect(text).not.toContain('consumer-secret');
    expect(text).not.toContain('access-token');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).toContain('{{tokenSecret}}');
    expect(text).toContain('consumer');
  });

  it('removes AWS secret keys and session tokens from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: 'AKID' },
            { key: 'secretKey', value: 'aws-secret' },
            { key: 'secretAccessKey', value: 'bruno-secret' },
            { key: 'sessionToken', value: 'session-token' },
          ],
        },
      }),
    );
    expect(text).toContain('AKID');
    for (const secret of ['aws-secret', 'bruno-secret', 'session-token'])
      expect(text).not.toContain(secret);
  });

  it('removes Hawk keys, also under the Insomnia name, and keeps API key names', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'hawk',
          hawk: [
            { key: 'authId', value: 'hawk-id' },
            { key: 'authKey', value: 'hawk-secret' },
            { key: 'key', value: 'insomnia-secret' },
          ],
        },
        item: [
          { request: { auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }] } } },
        ],
      }),
    );
    expect(text).toContain('hawk-id');
    expect(text).toContain('X-Api-Key');
    expect(text).not.toContain('hawk-secret');
    expect(text).not.toContain('insomnia-secret');
  });

  it('removes the JWT secret and private key from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'jwt',
          jwt: [
            { key: 'algorithm', value: 'HS256' },
            { key: 'secret', value: 'jwt-secret' },
            { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----' },
            { key: 'payload', value: '{"sub":"{{user}}"}' },
          ],
        },
      }),
    );
    expect(text).not.toContain('jwt-secret');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).toContain('HS256');
    expect(text).toContain('{{user}}');
  });

  it('removes the ASAP private key from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'asap',
          asap: [
            { key: 'iss', value: 'nexo' },
            { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----' },
          ],
        },
      }),
    );
    expect(text).toContain('nexo');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
  });

  it('removes the EdgeGrid access token and client secret from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'edgegrid',
          edgegrid: [
            { key: 'clientToken', value: 'akab-client' },
            { key: 'accessToken', value: 'akab-access' },
            { key: 'clientSecret', value: 'edgegrid-secret' },
            { key: 'baseURL', value: 'https://akab.luna.akamaiapis.net' },
          ],
        },
      }),
    );
    expect(text).toContain('akab-client');
    expect(text).toContain('akamaiapis.net');
    expect(text).not.toContain('akab-access');
    expect(text).not.toContain('edgegrid-secret');
  });

  it('removes the WSSE password from exported collections', () => {
    const text = JSON.stringify(
      exportableCollection({
        auth: {
          type: 'wsse',
          wsse: [
            { key: 'username', value: 'bob' },
            { key: 'password', value: 'wsse-secret' },
          ],
        },
      }),
    );
    expect(text).toContain('bob');
    expect(text).not.toContain('wsse-secret');
  });

  it('keeps only the names of the files a history request sent', () => {
    const request = newRequest('r');
    const file = { name: 'a.png', contentType: 'image/png', size: 3, content: 'AQID' };
    request.form = [
      { key: 'a', value: '', enabled: true, type: 'file', src: 'a.png', files: [file] },
    ];
    request.bodyFile = { src: 'a.png', file };
    const saved = historyRequest(request);
    expect(saved.form[0]).toEqual({
      key: 'a',
      value: '',
      enabled: true,
      type: 'file',
      src: 'a.png',
    });
    expect(saved.bodyFile).toEqual({ src: 'a.png' });
    expect(JSON.stringify(saved)).not.toContain('AQID');
    expect(historyRequest(newRequest('r')).bodyFile).toBeUndefined();
  });
});
