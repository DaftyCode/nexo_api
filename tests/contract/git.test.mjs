// Contract tests for Git remotes: addresses Git must never run, and the egress policy.
// Pushing and pulling against a repository are covered by the adapter's Rust tests, with a
// local bare repository that only tests may use.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freePort, startServer } from './server.mjs';

const gitInstalled = spawnSync('git', ['--version']).status === 0;
let server;
before(async () => {
  server = await startServer({ NEXO_EGRESS: 'deny-private' });
});
after(async () => {
  await server?.stop();
});

/** A Git operation; rejects with the API error. */
async function git(operation, payload = {}) {
  const { status, body } = await server.api('POST', `/git/${operation}`, {
    workspace: 'local',
    ...payload,
  });
  if (status !== 200) throw new Error(body?.error ?? `HTTP ${status}`);
  return body;
}

test('remotes accept only https and ssh addresses', { skip: !gitInstalled }, async () => {
  await git('init');
  for (const url of [
    'ext::sh -c touch% /tmp/pwned',
    '--upload-pack=touch /tmp/pwned',
    '-oProxyCommand=calc',
    'git@-oProxyCommand=calc:x',
    'file:///etc/passwd',
    'http://example.com/x.git',
    'git://example.com/x.git',
    '/tmp/repo',
    'https://user:password@example.com/x.git',
  ]) {
    await assert.rejects(git('remote.add', { remote: 'evil', url }), /Use an https|password/, url);
    await assert.rejects(git('clone', { workspace: 'local', url }), /Use an https|password/, url);
  }
  await assert.rejects(
    git('remote.add', { remote: '--mirror', url: 'https://example.com/x.git' }),
    /Invalid remote name/,
  );
  await assert.rejects(
    git('remote.add', { remote: 'origin', url: 'https://x.test', bad: 1 }),
    /bad/,
  );
  await git('remote.add', { remote: 'origin', url: 'git@github.com:acme/api.git' });
  await git('remote.add', { remote: 'local', url: 'https://127.0.0.1/acme/api.git' });
  assert.deepEqual((await git('remote.list')).remotes, [
    { name: 'local', url: 'https://127.0.0.1/acme/api.git' },
    { name: 'origin', url: 'git@github.com:acme/api.git' },
  ]);
  await git('remote.remove', { remote: 'origin' });
  assert.deepEqual(
    (await git('remote.list')).remotes.map((remote) => remote.name),
    ['local'],
  );
  await assert.rejects(git('fetch', { remote: 'origin' }), /no remote named origin/);
});

test('the egress policy applies before Git connects', { skip: !gitInstalled }, async () => {
  for (const operation of ['fetch', 'pull', 'push'])
    await assert.rejects(git(operation, { remote: 'local' }), /egress policy/, operation);
  const port = await freePort();
  await assert.rejects(
    git('clone', { workspace: 'local', url: `https://127.0.0.1:${port}/x.git` }),
    /project|egress policy/,
  );
  const { id } = (await server.api('POST', '/workspaces', { name: 'Clone' })).body;
  await assert.rejects(
    git('clone', { workspace: id, url: `https://127.0.0.1:${port}/x.git` }),
    /egress policy/,
  );
  // Refused before anything was written: the workspace can still clone.
  await assert.rejects(git('status', { workspace: id }), /Initialize/);
});
