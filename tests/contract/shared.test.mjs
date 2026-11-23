// Contract tests of the collections shared by the team (C-01): two Nexo on one folder, as two
// computers whose cloud client syncs it, and on a WebDAV server played here. One shares a
// collection sealed with a team key; the other brings it in with the key; what each saves
// reaches the other at its next look (a server only on Reload or when the workspace opens,
// and with nothing sent when nothing changed); what both changed is asked and either side
// kept; the file never carries a credential nor a value of the vault.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';

let ana;
let ben;
let folder;

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'nexo-shared-'));
  [ana, ben] = await Promise.all([startServer(), startServer()]);
});
after(async () => {
  await ana?.stop();
  await ben?.stop();
  await rm(folder, { recursive: true, force: true });
});

const request = (id, url, token) => ({
  id,
  name: id,
  request: {
    method: 'GET',
    url,
    ...(token ? { auth: { type: 'bearer', bearer: [{ key: 'token', value: token }] } } : {}),
  },
});
const read = async (server, id) => (await server.api('GET', `/documents/${id}`)).body;
const save = async (server, document) => {
  const saved = await server.api('PUT', '/documents', document);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
};

test('a collection shared by one Nexo is kept in step with another through one folder', async () => {
  const path = join(folder, 'Shop.nexo-collection');
  await save(ana, {
    id: 'c1',
    workspace_id: 'local',
    kind: 'collection',
    name: 'Shop',
    revision: 0,
    updated_at: 0,
    value: { info: { name: 'Shop', schema: '' }, item: [request('r1', '/orders', 'ana-token')] },
  });
  const shared = await ana.execute('shared.share', { collection: 'c1', path });
  assert.match(shared.key, /^nexo-team-key-[0-9a-f]{64}$/);
  const raw = await readFile(path, 'utf8');
  for (const secret of ['ana-token', '/orders', shared.key]) assert.ok(!raw.includes(secret), raw);

  // Ben brings it in, only with the key.
  await assert.rejects(ben.execute('shared.link', { path }), /team key/);
  const { collection } = await ben.execute('shared.link', { path, key: shared.key });
  const bens = await read(ben, collection);
  assert.equal(bens.name, 'Shop');
  assert.equal(bens.value.item[0].request.url, '/orders');
  assert.notEqual(bens.value.item[0].request.auth.bearer[0].value, 'ana-token');

  // What Ben saves reaches Ana at her next look; her own token stays hers.
  bens.value.item.push(request('r2', '/customers'));
  await save(ben, bens);
  const quiet = await ben.execute('shared.poll', {});
  assert.deepEqual(quiet.changed, []);
  const polled = await ana.execute('shared.poll', {});
  assert.deepEqual(polled.changed, ['c1']);
  const anas = await read(ana, 'c1');
  assert.deepEqual(
    anas.value.item.map((item) => item.id),
    ['r1', 'r2'],
  );
  assert.equal(anas.value.item[0].request.auth.bearer[0].value, 'ana-token');

  // Both change r1: Ana's save gets there first; Ben's next look keeps hers and asks him.
  anas.value.item[0].request.url = '/orders?by=ana';
  await save(ana, anas);
  const mine = await read(ben, collection);
  mine.value.item[0].request.url = '/orders?by=ben';
  await save(ben, mine);
  const asked = await ben.execute('shared.poll', {});
  assert.deepEqual(asked.links[0].conflicts, [{ id: 'r1', name: 'r1' }]);
  assert.equal((await read(ben, collection)).value.item[0].request.url, '/orders?by=ana');
  await ben.execute('shared.resolve', { collection, id: 'r1', keep: 'mine' });
  assert.equal((await read(ben, collection)).value.item[0].request.url, '/orders?by=ben');
  await ana.execute('shared.poll', {});
  assert.equal((await read(ana, 'c1')).value.item[0].request.url, '/orders?by=ben');

  // The status says how it is shared; stopping keeps the collection and the file.
  const status = await ana.execute('shared.status', {});
  assert.equal(status.links[0].encrypted, true);
  await ana.execute('shared.unlink', { collection: 'c1' });
  assert.deepEqual((await ana.execute('shared.status', {})).links, []);
  assert.equal((await read(ana, 'c1')).name, 'Shop');
  assert.ok((await readFile(path, 'utf8')).includes('A256GCM'));
});

test('a file that is not a shared collection, or not where it says, is refused', async () => {
  await assert.rejects(
    ana.execute('shared.link', { path: join(folder, 'notes.txt') }),
    /\.nexo-collection/,
  );
  await assert.rejects(
    ana.execute('shared.link', { path: join(folder, 'missing.nexo-collection') }),
    /no shared collection/,
  );
  await assert.rejects(
    ana.execute('shared.write', {
      location: { kind: 'folder', path: join(folder, 'x.nexo-collection') },
      content: {},
    }),
    /Nexo's own/,
  );
});

/** A WebDAV server: versions by ETag, `304` when nothing changed, `412` over another's version. */
async function dav() {
  const state = { body: undefined, version: 0, asked: [] };
  const signed = `Basic ${Buffer.from('ana:dav-pw').toString('base64')}`;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const etag = state.body ? `"v${state.version}"` : undefined;
      const { authorization, 'if-match': match, 'if-none-match': none } = request.headers;
      state.asked.push([request.method, none ?? match ?? ''].join(' ').trim());
      if (authorization !== signed) return response.writeHead(401).end();
      if (request.method === 'GET') {
        if (!state.body) return response.writeHead(404).end();
        if (none === etag) return response.writeHead(304, { etag }).end();
        return response.writeHead(200, { etag }).end(state.body);
      }
      if ((match && match !== etag) || (none === '*' && state.body)) {
        return response.writeHead(412).end();
      }
      state.body = Buffer.concat(chunks);
      state.version += 1;
      return response.writeHead(201, { etag: `"v${state.version}"` }).end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    server,
    state,
    url: `http://127.0.0.1:${server.address().port}/dav/Team.nexo-collection`,
  };
}

test('a collection on a server is asked only on Reload, and never written over', async () => {
  const { server, state, url } = await dav();
  const credential = { scheme: 'basic', user: 'ana', secret: 'dav-pw' };
  try {
    await save(ana, {
      id: 'c2',
      workspace_id: 'local',
      kind: 'collection',
      name: 'Team',
      revision: 0,
      updated_at: 0,
      value: { info: { name: 'Team', schema: '' }, item: [request('t1', '/team')] },
    });
    await ana.execute('shared.share', { collection: 'c2', url, credential, encrypt: false });
    assert.equal(state.version, 1);
    assert.ok(
      !(await ana.execute('shared.status', {})).links.some((l) =>
        JSON.stringify(l).includes('dav-pw'),
      ),
    );
    const { collection } = await ben.execute('shared.link', { url, credential });
    const bens = await read(ben, collection);
    bens.value.item.push(request('t2', '/team/members'));
    await save(ben, bens);
    assert.equal(state.version, 2);

    // Ana's look every few seconds leaves the server alone; Reload brings the change.
    const asked = state.asked.length;
    assert.deepEqual((await ana.execute('shared.poll', {})).changed, []);
    assert.equal(state.asked.length, asked);
    await ana.execute('shared.sync', { collection: 'c2' });
    assert.deepEqual(
      (await read(ana, 'c2')).value.item.map((item) => item.id),
      ['t1', 't2'],
    );
    // Nothing changed since: the server answers 304 and sends nothing.
    await ana.execute('shared.sync', { collection: 'c2' });
    assert.equal(state.asked.at(-1), 'GET "v2"');

    // Ana writes v3; Ben's save from v2 finds it and leaves his change for his next look.
    const anas = await read(ana, 'c2');
    anas.value.item[0].request.url = '/team?by=ana';
    await save(ana, anas);
    const mine = await read(ben, collection);
    mine.value.item[1].request.url = '/team/members?by=ben';
    await save(ben, mine);
    assert.equal(state.version, 3);
    assert.deepEqual((await ben.execute('shared.poll', {})).changed, [collection]);
    assert.equal(state.version, 4);
    const joined = JSON.parse(state.body.toString()).content.collection.item;
    assert.deepEqual(
      joined.map((item) => item.request.url),
      ['/team?by=ana', '/team/members?by=ben'],
    );
    await ana.execute('shared.unlink', { collection: 'c2' });
  } finally {
    server.close();
  }
});
