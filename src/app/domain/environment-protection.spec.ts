import {
  changingRequests,
  isGraphQLMutation,
  mayChangeData,
  readEnvironmentSettings,
  storedEnvironmentSettings,
} from './environment-protection';
import { Protocol } from './models';

describe('environment protection', () => {
  it('reads the colour and protection, anything unknown as none', () => {
    expect(readEnvironmentSettings({ color: '#E5534B', protection: 'readonly' })).toEqual({
      color: '#E5534B',
      protection: 'readonly',
    });
    expect(readEnvironmentSettings({ color: 'red', protection: 'locked' })).toEqual({
      color: '',
      protection: 'none',
    });
    expect(readEnvironmentSettings(undefined)).toEqual({ color: '', protection: 'none' });
    expect(readEnvironmentSettings('text').protection).toBe('none');
  });

  it('stores only what is set', () => {
    expect(storedEnvironmentSettings({ color: '', protection: 'none' })).toEqual({});
    expect(storedEnvironmentSettings({ color: '#57ab5a', protection: 'confirm' })).toEqual({
      color: '#57ab5a',
      protection: 'confirm',
    });
  });

  it('finds GraphQL mutations at the top level only, past comments and strings', () => {
    expect(isGraphQLMutation('mutation { cancel(id: 1) { id } }')).toBe(true);
    expect(isGraphQLMutation('query A { a } mutation B { b }')).toBe(true);
    expect(isGraphQLMutation('{ orders(note: "mutation") { id mutation } }')).toBe(false);
    expect(isGraphQLMutation('# mutation\n{ orders { id } }')).toBe(false);
    expect(isGraphQLMutation('subscription { mutationCount } }')).toBe(false);
  });

  it('tells which requests may change data', () => {
    const request = (method: string, protocol: Protocol = 'http', body = '') => ({
      method,
      protocol,
      body,
    });
    for (const method of ['GET', 'head', 'OPTIONS', 'TRACE'])
      expect(mayChangeData(request(method))).toBe(false);
    for (const method of ['POST', 'put', 'PATCH', 'DELETE', 'PURGE'])
      expect(mayChangeData(request(method))).toBe(true);
    expect(mayChangeData(request('POST', 'graphql', '{ orders { id } }'))).toBe(false);
    expect(mayChangeData(request('POST', 'graphql', 'mutation { x }'))).toBe(true);
  });

  it('counts the requests of a collection that may change data, folders included', () => {
    expect(changingRequests(undefined)).toBe(0);
    expect(
      changingRequests([
        { request: { method: 'GET' } },
        { request: 'https://plain.url' },
        null,
        { request: { method: 'DELETE' } },
        {
          item: [
            { request: { method: 'post' } },
            { request: { body: { mode: 'graphql', graphql: { query: 'mutation { x }' } } } },
            { request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '{ a }' } } } },
            { request: {} },
          ],
        },
      ]),
    ).toBe(3);
  });
});
