// Starts the real `nexo-server` binary for contract tests and talks to its HTTP API.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = `nexo-server${process.platform === 'win32' ? '.exe' : ''}`;
export const binary = resolve(
  process.env.NEXO_SERVER_BINARY ??
    join(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', executable),
);

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on('error', reject);
  });
}

export async function until(check, { attempts = 300, delay = 20 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error('Timed out waiting for a condition');
}

/** Starts a server with its own data directory. Extra environment variables are optional. */
export async function startServer(environment = {}) {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), 'nexo-contract-'));
  const token = 'contract-token';
  const child = spawn(binary, ['--api-only', '--port', String(port)], {
    env: {
      ...process.env,
      NEXO_DATA_DIR: directory,
      NEXO_LOCAL_TOKEN: token,
      NEXO_MASTER_KEY: 'a'.repeat(64),
      NEXO_EGRESS: '',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => (logs += chunk));
  child.stderr.on('data', (chunk) => (logs += chunk));
  const base = `http://127.0.0.1:${port}/api`;
  async function api(method, path, payload) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }
  /** Runs an engine operation in the default workspace; rejects with the API error. */
  async function execute(operation, payload = {}) {
    const { status, body } = await api('POST', `/execute/${operation}`, {
      workspace: 'local',
      ...payload,
    });
    if (status !== 200) {
      const error = new Error(body?.error ?? `HTTP ${status}`);
      error.status = status;
      throw error;
    }
    return body;
  }
  try {
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error(`nexo-server exited:\n${logs}`);
        try {
          return (await fetch(`${base}/health`)).ok;
        } catch {
          return false;
        }
      },
      { attempts: 500 },
    );
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    api,
    execute,
    base,
    logs: () => logs,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A local HTTP fixture; `handler(request, body, response)` writes the reply. */
export async function fixture(handler) {
  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => handler(request, body, response));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
