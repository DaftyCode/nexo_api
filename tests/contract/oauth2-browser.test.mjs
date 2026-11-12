// Contract tests for the OAuth 2.0 browser sign-in: loopback, relay and manual.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freePort,
  signIn,
  finished,
  server,
  received,
  details,
  inheriting,
  browserSettings,
} from './oauth2-fixture.mjs';

test('loopback: PKCE sign-in returns to a local Callback URL that Nexo listens on', async () => {
  const port = await freePort();
  const callback = `http://127.0.0.1:${port}/cb`;
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code_with_pkce' },
        { key: 'redirect_uri', value: callback },
      ]),
    ),
  );
  assert.equal(started.mode, 'loopback');
  assert.equal(started.redirectUri, callback);
  assert.equal(started.opened, false);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('client_id'), 'app');

  // Only the callback path with this sign-in's state is accepted.
  assert.equal((await fetch(`http://127.0.0.1:${port}/other?code=x`)).status, 404);
  assert.equal((await fetch(`${callback}?code=x&state=forged`)).status, 400);
  assert.equal(
    (await server.execute('oauth2.authorize', { action: 'status', session: started.session }))
      .state,
    'waiting',
  );

  const back = await signIn(started.authorizationUrl);
  const page = await fetch(back);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /You can close this tab/);
  const result = await finished(started.session);
  assert.equal(result.state, 'done');
  assert.equal((await details(result.token.id)).accessToken, 'code-token');
  const exchange = received.at(-1).form;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.client_id, 'app');
  assert.ok(exchange.code_verifier.length >= 43);
  // The listener is closed afterwards.
  await assert.rejects(fetch(callback));
});

test('relay: "Authorize using browser" goes through Nexo callback page to a one-time port', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'useBrowser', value: true },
      ]),
    ),
  );
  assert.equal(started.mode, 'relay');
  assert.equal(started.redirectUri, 'https://relay.nexo.test/oauth/callback');
  const back = new URL(await signIn(started.authorizationUrl));
  assert.equal(back.origin + back.pathname, started.redirectUri);
  // What the callback page does: forward the answer to the port at the end of `state`.
  const port = back.searchParams.get('state').split('.').at(-1);
  const page = await fetch(`http://127.0.0.1:${port}/callback${back.search}`);
  assert.equal(page.status, 200);
  const result = await finished(started.session);
  assert.equal((await details(result.token.id)).accessToken, 'code-token');
});

test('manual: the implicit grant completes with the pasted address, also with Postman URL', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'implicit' },
        { key: 'redirect_uri', value: 'https://oauth.pstmn.io/v1/browser-callback' },
      ]),
    ),
  );
  assert.equal(started.mode, 'manual');
  const back = await signIn(started.authorizationUrl);
  assert.match(back, /#access_token=implicit-token/);
  const result = await server.execute('oauth2.authorize', {
    action: 'complete',
    session: started.session,
    url: back,
  });
  assert.equal(result.state, 'done');
  assert.equal((await details(result.token.id)).accessToken, 'implicit-token');
});

test('cancelled and refused sign-ins are reported', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'redirect_uri', value: 'https://app.test/back' },
      ]),
    ),
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const refused = await server.execute('oauth2.authorize', {
    action: 'complete',
    session: started.session,
    url: `https://app.test/back?error=access_denied&error_description=Denied&state=${state}`,
  });
  assert.equal(refused.state, 'error');
  assert.match(refused.error, /access_denied/);

  const other = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'redirect_uri', value: 'https://app.test/back' },
      ]),
    ),
  );
  assert.deepEqual(
    await server.execute('oauth2.authorize', { action: 'cancel', session: other.session }),
    { state: 'cancelled' },
  );
  await assert.rejects(
    server.execute('oauth2.authorize', { action: 'status', session: other.session }),
    /no longer in progress/,
  );
});
