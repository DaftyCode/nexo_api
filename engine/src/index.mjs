import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { OperationRegistry } from './application/registry.mjs';
import { RuntimeAdapter } from './adapters/runtime.mjs';
import { importArtifact, generateCode } from './adapters/import-export.mjs';
import { RealtimeAdapter, grpcRequest } from './adapters/realtime.mjs';
import {
  MockAdapter,
  DatasetAdapter,
  EncryptedVault,
  mcpRequest,
} from './adapters/local-services.mjs';

const dataDirectory = process.env.NEXO_DATA_DIR ?? join(process.cwd(), '.nexo');
await mkdir(dataDirectory, { recursive: true });
let key = process.env.NEXO_MASTER_KEY;
if (!key) {
  const keyPath = join(dataDirectory, 'master.key');
  try {
    key = await readFile(keyPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32).toString('hex');
    await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  }
}
if (!/^[a-f0-9]{64}$/i.test(key))
  throw new Error('NEXO_MASTER_KEY must be 64 hexadecimal characters');
const token = process.env.NEXO_ENGINE_TOKEN;
if (!token) throw new Error('Private engine token is required');
const worker =
  process.env.NEXO_RUNTIME_WORKER ??
  join(dirname(fileURLToPath(import.meta.url)), 'runtime-worker.mjs');
const runtime = new RuntimeAdapter(worker),
  realtime = new RealtimeAdapter(),
  mocks = new MockAdapter(),
  datasets = new DatasetAdapter(join(dataDirectory, 'datasets')),
  vault = new EncryptedVault(join(dataDirectory, 'vault'), Buffer.from(key, 'hex'));
const registry = new OperationRegistry();
registry.register('request', (actor, payload) => runtime.request(actor, payload));
registry.register('run', (actor, payload) =>
  payload.action === 'status'
    ? runtime.status(actor, payload.id)
    : { id: runtime.start(actor, payload), state: 'running' },
);
registry.register('cancel', (actor, payload) => runtime.cancel(actor, payload.id));
registry.register('import', importArtifact).register('codegen', generateCode);
registry
  .register('realtime.connect', (a, p) => realtime.connect(a, p))
  .register('realtime.send', (a, p) => realtime.send(a, p))
  .register('realtime.close', (a, p) => realtime.disconnect(a, p))
  .register('realtime.poll', (a, p) => realtime.poll(a, p));
registry.register('grpc', grpcRequest);
registry
  .register('mock.start', (a, p) => mocks.start(a, p))
  .register('mock.stop', (a, p) => mocks.stop(a, p))
  .register('mock.list', (a) => mocks.list(a));
function queryDataset(actor, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dataset-worker.mjs', import.meta.url), {
      workerData: { directory: join(dataDirectory, 'datasets'), actor, payload },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Dataset query exceeded the 5 second limit'));
    }, 5000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      worker.terminate();
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
registry
  .register('dataset.import', (a, p) => datasets.import(a, p))
  .register('dataset.query', queryDataset)
  .register('dataset.schema', (a, p) =>
    queryDataset(a, { ...p, sql: 'SELECT * FROM data LIMIT 1' }),
  );
registry.register('mcp.request', mcpRequest);
for (const operation of ['put', 'get', 'remove'])
  registry.register(`vault.${operation}`, (a, p) => vault.execute(a, operation, p));
registry.register('oauth.token', async (_, p) => {
  const url = new URL(p.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('HTTP token endpoint required');
  const body = new URLSearchParams(p.fields ?? {});
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...p.headers },
    body,
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
});
// Every request receives cookie state explicitly; these operations manage the actor-scoped jar.
registry.register('cookies.list', (a) => ({ cookies: runtime.cookies(a) }));
registry.register('cookies.clear', (a) => runtime.clearCookies(a));
const performanceJobs = new Map();
registry.register('performance', (actor, payload) => {
  if (payload.action === 'status') {
    const job = performanceJobs.get(`${actor}:${payload.id}`);
    if (!job) throw new Error('Performance run not found');
    return job;
  }
  const id = crypto.randomUUID(),
    job = {
      id,
      state: 'running',
      completed: 0,
      errors: 0,
      times: [],
      startedAt: Date.now(),
      duration: 0,
    };
  performanceJobs.set(`${actor}:${id}`, job);
  const users = Math.min(Math.max(payload.users ?? 1, 1), 4),
    duration = Math.min(Math.max(payload.duration ?? 10, 1), 120) * 1000;
  const run = async (index) => {
    if (payload.profile === 'ramp-up')
      await new Promise((r) => setTimeout(r, (index * duration) / users / 2));
    while (job.state === 'running' && Date.now() - job.startedAt < duration) {
      try {
        const result = await runtime.request(actor, {
          request: payload.request,
          variables: payload.variables,
          timeout: 15000,
        });
        job.completed++;
        job.times.push(result.time);
        if (result.error || result.status >= 400) job.errors++;
      } catch {
        job.errors++;
      }
      if (job.times.length > 10000) job.times.shift();
    }
  };
  Promise.all(Array.from({ length: users }, (_, i) => run(i))).then(() => {
    job.state = job.state === 'cancelled' ? 'cancelled' : 'completed';
    job.duration = Date.now() - job.startedAt;
    const sorted = job.times.toSorted((a, b) => a - b);
    job.summary = {
      requests: job.completed,
      errors: job.errors,
      average: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      rps: job.completed / (job.duration / 1000),
    };
  });
  return { id, state: job.state };
});
registry.register('performance.cancel', (actor, payload) => {
  const job = performanceJobs.get(`${actor}:${payload.id}`);
  if (!job) throw new Error('Performance run not found');
  job.state = 'cancelled';
  return job;
});

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const received = Buffer.from(req.headers.authorization ?? ''),
    expected = Buffer.from(`Bearer ${token}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }
  if (req.url === '/health') {
    return res.end(JSON.stringify({ ready: true, node: process.versions.node }));
  }
  if (req.method !== 'POST' || req.url !== '/execute') {
    res.writeHead(404);
    return res.end('{}');
  }
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Payload exceeds 16 MB');
      chunks.push(chunk);
    }
    const { actor, operation, payload } = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof actor !== 'string' || !actor) throw new Error('Actor required');
    const result = await registry.execute(actor, operation, payload ?? {});
    res.end(JSON.stringify({ result }));
  } catch (error) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(Number(process.env.NEXO_ENGINE_PORT ?? 0), '127.0.0.1', () =>
  process.stdout.write(`NEXO_ENGINE_READY:${server.address().port}\n`),
);
function close() {
  runtime.close();
  realtime.close();
  mocks.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
if (process.env.NEXO_PARENT_PIPE === '1') {
  process.stdin.resume();
  process.stdin.on('end', close);
}
