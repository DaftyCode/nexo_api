// Shared setup of the OAuth 2.0 contract tests: the server and a provider that records what
// it receives, started once per test file.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { fixture, startServer } from './server.mjs';

export const freePort = () =>
  new Promise((done) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
/** Follows the provider's redirect, as the browser would, and returns where it led. */
export async function signIn(authorizationUrl) {
  const answer = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(answer.status, 302);
  return answer.headers.get('location');
}
/** Polls a sign-in until it finishes. */
export async function finished(session) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await server.execute('oauth2.authorize', { action: 'status', session });
    if (status.state !== 'waiting') return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The sign-in did not finish');
}

export let server;
export let provider;
export const received = [];
/** Authorization requests the provider received, by the code it issued. */
export const issued = new Map();
export const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');
before(async () => {
  server = await startServer();
  // A provider that records what it receives and answers like a real one: it signs in at
  // /authorize (redirecting back with a code, or a token for the implicit grant) and checks
  // the PKCE verifier when the code is exchanged at the token endpoint.
  provider = await fixture((request, body, response) => {
    const address = new URL(request.url, 'http://provider');
    if (address.pathname === '/echo') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ authorization: request.headers.authorization ?? null }));
    }
    if (address.pathname === '/authorize') {
      const query = Object.fromEntries(address.searchParams);
      const back = new URL(query.redirect_uri);
      if (query.response_type === 'token') {
        back.hash = new URLSearchParams({
          access_token: 'implicit-token',
          token_type: 'Bearer',
          state: query.state,
        }).toString();
      } else {
        const code = `code-${issued.size + 1}`;
        issued.set(code, query);
        back.search = new URLSearchParams({ code, state: query.state }).toString();
      }
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    const form = Object.fromEntries(new URLSearchParams(body));
    received.push({ url: request.url, headers: request.headers, form });
    response.setHeader('content-type', 'application/json');
    if (form.grant_type === 'authorization_code') {
      const authorized = issued.get(form.code);
      const verified =
        authorized?.code_challenge_method === 'S256'
          ? challengeOf(form.code_verifier ?? '') === authorized.code_challenge
          : !authorized?.code_challenge || form.code_verifier === authorized.code_challenge;
      if (!authorized || !verified || form.redirect_uri !== authorized.redirect_uri) {
        response.statusCode = 400;
        return response.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      return response.end(JSON.stringify({ access_token: 'code-token', expires_in: 60 }));
    }
    if (form.client_secret === 'wrong') {
      response.statusCode = 401;
      return response.end(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        }),
      );
    }
    response.end(
      JSON.stringify({
        access_token: form.grant_type === 'refresh_token' ? 'renewed-token' : 'new-token',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        // A scope of "short" gets a token that expires within a minute.
        expires_in: form.scope === 'short' ? 30 : 300,
      }),
    );
  });
});
after(async () => {
  await provider?.close();
  await server?.stop();
});

export const details = (id) => server.execute('oauth2.tokens', { action: 'details', id });

/** A request that inherits the collection's OAuth 2.0 settings, as in a Postman export. */
export const inheriting = (settings, extra = {}) => ({
  request: { url: 'https://api.test/x', auth: { type: 'inherit' } },
  variables: [{ key: 'tokenUrl', value: `${provider.url}/token`, enabled: true }],
  context: {
    ancestors: [
      {
        name: 'API',
        variable: [{ key: 'clientId', value: 'collection-client' }],
        auth: { type: 'oauth2', oauth2: settings },
      },
    ],
  },
  ...extra,
});

export const browserSettings = (extra) => [
  { key: 'authUrl', value: `${provider.url}/authorize` },
  { key: 'accessTokenUrl', value: `${provider.url}/token` },
  { key: 'clientId', value: 'app' },
  { key: 'scope', value: 'openid' },
  { key: 'client_authentication', value: 'body' },
  ...extra,
];
