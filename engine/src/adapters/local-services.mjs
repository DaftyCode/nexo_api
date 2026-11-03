import http from 'node:http';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateUrl } from '../domain/collection.mjs';

export class MockAdapter {
  #servers = new Map();
  async start(actor, payload) {
    const id = payload.id ?? randomUUID();
    if (this.#servers.has(`${actor}:${id}`)) throw new Error('Mock already running');
    const examples = payload.examples ?? [];
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        if (body.length < 65536) body += chunk;
      });
      req.on('end', () => {
        const path = new URL(req.url, 'http://localhost').pathname;
        const match = examples.find(
          (e) => (!e.method || e.method === req.method) && (e.path === path || e.path === '*'),
        );
        calls.push({ time: Date.now(), method: req.method, path, body });
        if (calls.length > 200) calls.shift();
        const respond = () => {
          res.writeHead(match?.status ?? 404, {
            'content-type': 'application/json',
            ...(match?.headers ?? {}),
          });
          res.end(
            typeof match?.body === 'string'
              ? match.body
              : JSON.stringify(match?.body ?? { error: 'No matching mock example' }),
          );
        };
        if (match?.delay) setTimeout(respond, Math.min(match.delay, 30000));
        else respond();
      });
    });
    // Local mock sockets never become unauthenticated public endpoints in server mode.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(payload.port ?? 0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    this.#servers.set(`${actor}:${id}`, { id, server, port, calls });
    return { id, port, url: `http://127.0.0.1:${port}` };
  }
  list(actor) {
    return [...this.#servers.entries()]
      .filter(([key]) => key.startsWith(`${actor}:`))
      .map(([, s]) => ({
        id: s.id,
        port: s.port,
        url: `http://127.0.0.1:${s.port}`,
        calls: s.calls,
      }));
  }
  stop(actor, payload) {
    const mock = this.#servers.get(`${actor}:${payload.id}`);
    if (!mock) throw new Error('Mock not found');
    mock.server.closeAllConnections();
    mock.server.close();
    this.#servers.delete(`${actor}:${payload.id}`);
    return { stopped: true };
  }
  close() {
    for (const mock of this.#servers.values()) {
      mock.server.closeAllConnections();
      mock.server.close();
    }
  }
}

const safeName = (value) => createHash('sha256').update(value).digest('hex');
export class DatasetAdapter {
  constructor(directory) {
    this.directory = directory;
  }
  async import(actor, payload) {
    let rows = payload.rows;
    if (!rows && payload.content) {
      try {
        rows = JSON.parse(payload.content);
      } catch {
        rows = parseCsv(payload.content);
      }
    }
    if (!Array.isArray(rows) || rows.length > 100000)
      throw new Error('Dataset must contain an array with at most 100,000 rows');
    const id = payload.id ?? randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      join(this.directory, `${safeName(actor + ':' + id)}.json`),
      JSON.stringify(rows),
    );
    return { id, rows: rows.length, columns: Object.keys(rows[0] ?? {}) };
  }
  async query(actor, payload) {
    const rows = JSON.parse(
      await readFile(join(this.directory, `${safeName(actor + ':' + payload.id)}.json`), 'utf8'),
    );
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (!columns.length) return { columns: [], rows: [] };
    const quote = (x) => '"' + x.replaceAll('"', '""') + '"';
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE data (${columns.map((c) => quote(c)).join(',')})`);
      const insert = db.prepare(`INSERT INTO data VALUES (${columns.map(() => '?').join(',')})`);
      db.exec('BEGIN');
      for (const row of rows)
        insert.run(
          ...columns.map((c) => {
            const v = row[c];
            return v === undefined || v === null
              ? null
              : typeof v === 'object'
                ? JSON.stringify(v)
                : typeof v === 'boolean'
                  ? Number(v)
                  : v;
          }),
        );
      db.exec('COMMIT');
      const sql = (payload.sql ?? 'SELECT * FROM data LIMIT 100').trim();
      if (
        !/^(SELECT|WITH)\b/i.test(sql) ||
        /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|load_extension|readfile|writefile)\b/i.test(
          sql,
        ) ||
        sql.replace(/;\s*$/, '').includes(';')
      )
        throw new Error('Only a single read-only SELECT query is supported');
      db.exec('PRAGMA query_only=ON');
      let count = 0;
      const result = [];
      for (const row of db.prepare(sql).iterate()) {
        result.push(row);
        if (++count >= 10000) break;
      }
      return {
        columns: result.length ? Object.keys(result[0]) : columns,
        rows: result,
        truncated: count >= 10000,
        totalRows: rows.length,
      };
    } finally {
      db.close();
    }
  }
}
export function parseCsv(text) {
  const records = [];
  let row = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some(Boolean)) records.push(row);
  if (quoted) throw new Error('Unclosed CSV quote');
  const headers = records.shift() ?? [];
  return records.map((values) =>
    Object.fromEntries(
      headers.map((name, i) => {
        const v = values[i] ?? '';
        return [name, v !== '' && Number.isFinite(Number(v)) ? Number(v) : v];
      }),
    ),
  );
}

export class EncryptedVault {
  constructor(directory, key) {
    this.directory = directory;
    this.key = key;
  }
  async execute(actor, operation, payload) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${safeName(actor)}.json`);
    let values = {};
    try {
      values = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const name = payload.name;
    if (!name || name.length > 200) throw new Error('Secret name is required');
    if (operation === 'get') {
      const value = values[name];
      if (!value) throw new Error('Secret not found');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return {
        value: Buffer.concat([
          decipher.update(Buffer.from(value.data, 'hex')),
          decipher.final(),
        ]).toString('utf8'),
      };
    }
    if (operation === 'put') {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([cipher.update(payload.value, 'utf8'), cipher.final()]);
      values[name] = {
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
      };
    }
    if (operation === 'remove') delete values[name];
    await writeFile(path, JSON.stringify(values), { mode: 0o600 });
    return { saved: true };
  }
}

export async function mcpRequest(_, payload) {
  validateUrl(payload.url);
  const response = await fetch(payload.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(payload.sessionId ? { 'mcp-session-id': payload.sessionId } : {}),
      ...payload.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: payload.method ?? 'tools/list',
      params: payload.params ?? {},
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5));
        } catch {
          return l.slice(5);
        }
      });
  }
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    result: value,
  };
}
