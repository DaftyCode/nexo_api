// Starts nexo-server with the built interface and signs the browser in with a one-time link.
import { test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      const child = spawn(
        binary,
        ['--port', String(listen), '--web', 'dist/nexo/browser', '--no-open'],
        {
          env: {
            ...process.env,
            NEXO_DATA_DIR: directory,
            NEXO_LOCAL_TOKEN: token,
            NEXO_MASTER_KEY: 'b'.repeat(64),
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
        response.end(JSON.stringify({ path: request.url, method: request.method }));
      });
      await new Promise((r) => echo.listen(0, '127.0.0.1', r));
      await use({
        base,
        echo: `http://127.0.0.1:${echo.address().port}`,
        async signIn(page) {
          const response = await fetch(`${base}/api/session/link`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          const { path } = await response.json();
          await page.goto(base + path);
          await page.waitForURL(/\/workspace/);
        },
      });
      echo.close();
      child.kill();
      await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
      await rm(directory, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});
export { expect } from '@playwright/test';
