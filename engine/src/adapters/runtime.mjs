import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { asCollection } from '../domain/collection.mjs';
function redact(value, secrets) {
  if (typeof value === 'string')
    return secrets.reduce(
      (text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}

export class RuntimeAdapter {
  #jobs = new Map();
  #jars = new Map();
  #worker;
  constructor(worker = fileURLToPath(new URL('./runtime-worker.mjs', import.meta.url))) {
    this.#worker = worker;
  }
  start(actor, payload) {
    const active = [...this.#jobs.values()].filter(
      (j) => j.actor === actor && j.state === 'running',
    );
    if (active.length >= 8) throw new Error('Maximum of eight active runs per user');
    const id = payload.id ?? randomUUID();
    if (this.#jobs.has(`${actor}:${id}`))
      throw new Error('This execution identifier already exists');
    const child = fork(this.#worker, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [
        '--max-old-space-size=256',
        '--permission',
        '--allow-net',
        `--allow-fs-read=${dirname(this.#worker)}`,
        `--allow-fs-read=${resolve(dirname(this.#worker), '../domain')}`,
        `--allow-fs-read=${dirname(dirname(fileURLToPath(import.meta.resolve('undici/package.json'))))}`,
        `--allow-fs-read=${resolve('package.json')}`,
        `--allow-fs-read=${resolve('engine/package.json')}`,
      ],
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        NODE_ENV: 'production',
      },
    });
    const job = {
      id,
      actor,
      state: 'running',
      results: [],
      assertions: [],
      logs: [],
      startedAt: Date.now(),
      child,
    };
    this.#jobs.set(`${actor}:${id}`, job);
    const timeout = setTimeout(
      () => {
        if (job.state === 'running') {
          job.state = 'failed';
          job.error = 'Execution exceeded time limit';
          child.kill();
        }
      },
      Math.min(payload.globalTimeout ?? 300000, 3600000) + 2000,
    );
    timeout.unref();
    child.on('message', (raw) => {
      const message = redact(raw, Object.values(payload.resolvedSecrets ?? {}));
      if (message.type === 'request') job.results.push(message.result);
      if (message.type === 'assertion') job.assertions.push(message.assertion);
      if (message.type === 'done') {
        if (raw.cookieJar) this.#jars.set(actor, raw.cookieJar);
        delete message.cookieJar;
        Object.assign(job, message, { state: message.error ? 'failed' : 'completed' });
        delete job.type;
        clearTimeout(timeout);
      }
    });
    child.on('error', (error) => {
      job.state = 'failed';
      job.error = error.message;
      clearTimeout(timeout);
    });
    child.on('exit', () => {
      clearTimeout(timeout);
      if (job.state === 'running') {
        job.state = 'failed';
        job.error = 'Execution process exited unexpectedly';
      }
    });
    child.send({ ...payload, cookieJar: this.#jars.get(actor), collection: asCollection(payload) });
    for (const [key, value] of this.#jobs)
      if (value.state !== 'running' && Date.now() - value.startedAt > 3600000)
        this.#jobs.delete(key);
    return id;
  }
  status(actor, id) {
    const job = this.#jobs.get(`${actor}:${id}`);
    if (!job) throw new Error('Execution not found');
    const { child, actor: owner, ...result } = job;
    return result;
  }
  cancel(actor, id) {
    const job = this.#jobs.get(`${actor}:${id}`);
    if (!job) throw new Error('Execution not found');
    if (job.state === 'running') {
      job.state = 'cancelled';
      job.child.kill();
    }
    return this.status(actor, id);
  }
  async request(actor, payload) {
    const id = this.start(actor, payload);
    while (this.status(actor, id).state === 'running')
      await new Promise((resolve) => setTimeout(resolve, 25));
    const job = this.status(actor, id);
    if (job.error && !job.results.length) throw new Error(job.error);
    return { ...job.results.at(-1), assertions: job.assertions, logs: job.logs, executionId: id };
  }
  close() {
    for (const job of this.#jobs.values()) if (job.state === 'running') job.child.kill();
  }
  cookies(actor) {
    return this.#jars.get(actor)?.cookies ?? [];
  }
  clearCookies(actor) {
    this.#jars.delete(actor);
    return { cleared: true };
  }
}
