// Starts nexo-server with the built interface and signs the browser in with a one-time link.
import { test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

/** A small GraphQL schema, as introspection answers it. */
const scalar = (name) => ({ kind: 'SCALAR', name, ofType: null });
const introspection = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: null,
      subscriptionType: { name: 'Subscription' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: 'A user by ID',
              args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: scalar('ID') } }],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Subscription',
          fields: [{ name: 'ticks', args: [], type: scalar('Int') }],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [{ name: 'name', args: [], type: scalar('String') }],
        },
        scalar('ID'),
        scalar('Int'),
        scalar('String'),
      ],
    },
  },
};

const executable = `nexo-server${process.platform === 'win32' ? '.exe' : ''}`;
const binary = resolve(
  process.env.NEXO_SERVER_BINARY ??
    join(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', executable),
);
const port = () =>
  new Promise((done) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

export const test = base.extend({
  // One server per test file run.
  nexo: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), 'nexo-e2e-'));
      const token = 'e2e-token';
      const listen = await port();
      // Stands for the user's ~/.netrc in the Netrc test.
      const netrc = join(directory, 'netrc');
      await writeFile(netrc, 'machine 127.0.0.1 login e2e-user password e2e-netrc\n');
      const child = spawn(
        binary,
        ['--port', String(listen), '--web', 'dist/nexo/browser', '--no-open'],
        {
          env: {
            ...process.env,
            NEXO_DATA_DIR: directory,
            NEXO_LOCAL_TOKEN: token,
            NEXO_MASTER_KEY: 'b'.repeat(64),
            NEXO_NO_BROWSER: '1',
            NEXO_NETRC: netrc,
          },
          stdio: 'ignore',
        },
      );
      const base = `http://127.0.0.1:${listen}`;
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        try {
          ready = (await fetch(`${base}/api/health`)).ok;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (!ready) throw new Error(`nexo-server did not start: ${binary}`);
      // A local API the requests in the tests can reach.
      const echo = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        // GraphQL subscriptions over server-sent events (graphql-sse): three ticks.
        if (request.url === '/graphql/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const tick of [1, 2, 3])
            response.write(`event: next\ndata: ${JSON.stringify({ data: { ticks: tick } })}\n\n`);
          return response.end('event: complete\ndata:\n\n');
        }
        // GraphQL: the schema by introspection, and an answer to any other query.
        // A small MCP server: one resource, one template and one prompt.
        if (request.url === '/mcp') {
          let body = '';
          request.on('data', (chunk) => (body += chunk));
          request.on('end', () => {
            const { id, method, params } = JSON.parse(body);
            const results = {
              initialize: {
                protocolVersion: '2025-06-18',
                capabilities: { resources: {}, prompts: {} },
                serverInfo: { name: 'e2e', version: '1' },
              },
              'resources/list': {
                resources: [{ uri: 'docs://readme', name: 'Readme', mimeType: 'text/plain' }],
              },
              'resources/read': {
                contents: [{ uri: params?.uri, mimeType: 'text/plain', text: 'Read me first' }],
              },
              'prompts/list': {
                prompts: [
                  {
                    name: 'greet',
                    description: 'Greets someone',
                    arguments: [{ name: 'name', required: true }],
                  },
                ],
              },
              'prompts/get': {
                messages: [
                  {
                    role: 'user',
                    content: { type: 'text', text: `Say hello to ${params?.arguments?.name}` },
                  },
                ],
              },
            };
            if (method === 'initialize') response.setHeader('mcp-session-id', 'e2e-session');
            response.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] ?? {} }));
          });
          return;
        }
        // GraphQL queries, also at the subscription address, as servers often serve both.
        if (
          request.url === '/graphql' ||
          (request.url === '/subscriptions' && request.method === 'POST')
        ) {
          let body = '';
          request.on('data', (chunk) => (body += chunk));
          request.on('end', () =>
            response.end(
              JSON.stringify(
                body.includes('__schema') ? introspection : { data: { user: { name: 'Ana' } } },
              ),
            ),
          );
          return;
        }
        // Uploads: the type of the body and the SHA-256 of each file or of the whole body.
        if (request.url.startsWith('/upload')) {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', async () => {
            const body = Buffer.concat(chunks);
            const type = request.headers['content-type'] ?? '';
            const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
            const files = [];
            if (type.startsWith('multipart/form-data')) {
              const form = await new Response(body, {
                headers: { 'content-type': type },
              }).formData();
              for (const [field, value] of form.entries())
                if (typeof value !== 'string')
                  files.push(
                    `${field}:${value.name}:${value.type}:${hash(Buffer.from(await value.arrayBuffer()))}`,
                  );
            }
            response.end(JSON.stringify({ type, sha256: hash(body), files }));
          });
          return;
        }
        // A sign-in page and a token endpoint for the OAuth 2.0 tests.
        if (request.url.startsWith('/authorize')) {
          const query = new URL(request.url, 'http://e2e').searchParams;
          const back = new URL(query.get('redirect_uri'));
          back.search = new URLSearchParams({
            code: 'e2e-code',
            state: query.get('state'),
          }).toString();
          response.writeHead(302, { location: back.toString() });
          return response.end();
        }
        // A long body: 500 items, to scroll through.
        if (request.url === '/long')
          return response.end(
            JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ item: index }))),
          );
        // A session cookie, for the cookie manager.
        if (request.url === '/set-cookie')
          response.setHeader('set-cookie', 'e2e_session=abc; Path=/');
        if (request.url === '/token')
          return response.end(
            JSON.stringify({ access_token: 'e2e-token', refresh_token: 'r1', expires_in: 3600 }),
          );
        response.end(
          JSON.stringify({
            path: request.url,
            method: request.method,
            authorization: request.headers.authorization ?? null,
            wsse: request.headers['x-wsse'] ?? null,
            cookie: request.headers.cookie ?? null,
          }),
        );
      });
      // GraphQL subscriptions (graphql-transport-ws): three ticks for each subscription.
      const subscriptions = new WebSocketServer({
        server: echo,
        path: '/subscriptions',
        handleProtocols: (offered) =>
          offered.has('graphql-transport-ws') ? 'graphql-transport-ws' : false,
      });
      subscriptions.on('connection', (socket) =>
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'connection_init')
            socket.send(JSON.stringify({ type: 'connection_ack' }));
          if (message.type === 'subscribe')
            for (const tick of [1, 2, 3])
              socket.send(
                JSON.stringify({
                  id: message.id,
                  type: 'next',
                  payload: { data: { ticks: tick } },
                }),
              );
        }),
      );
      await new Promise((r) => echo.listen(0, '127.0.0.1', r));
      await use({
        base,
        echo: `http://127.0.0.1:${echo.address().port}`,
        /**
         * Opens the app with a one-time link. The tests share one server, so tabs reopen only
         * when asked: otherwise each test would start with the tabs the previous one left.
         */
        async signIn(page, { restoreTabs = false } = {}) {
          if (!restoreTabs)
            await page.addInitScript(() =>
              localStorage.setItem('nexo.preference.session.restoreTabs', 'off'),
            );
          const response = await fetch(`${base}/api/session/link`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          const { path } = await response.json();
          await page.goto(base + path);
          await page.waitForURL(/\/workspace/);
        },
      });
      subscriptions.close();
      echo.close();
      child.kill();
      await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
      await rm(directory, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});
export { expect } from '@playwright/test';
