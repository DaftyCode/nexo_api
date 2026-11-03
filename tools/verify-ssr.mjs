import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const port = 4000;
const child = spawn(process.execPath, ['dist/nexo/server/server.mjs'], {
  env: {
    ...process.env,
    PORT: String(port),
    NG_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    NEXO_API_URL: 'http://127.0.0.1:8080',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (x) => (logs += x));
child.stderr.on('data', (x) => (logs += x));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, logs);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const html = await home.text();
  assert.ok(html.includes('Your APIs.'));
  assert.ok(html.includes('name="description"'));
  assert.ok(html.includes('Your rules.'));
  const docs = await fetch(`http://127.0.0.1:${port}/docs`);
  assert.equal(docs.status, 200);
  assert.ok((await docs.text()).includes('Send a request'));
  const workspace = await fetch(`http://127.0.0.1:${port}/workspace`);
  assert.equal(workspace.status, 200);
  assert.ok((workspace.headers.get('x-robots-tag') ?? '').includes('noindex'));
  const api = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).name, 'Nexo API');
  const result = {
    passed: 5,
    checks: [
      'SSR home contains rendered content',
      'SEO description present',
      'SSR documentation renders',
      'private workspace noindex header',
      'same-origin Rust API proxy',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  await mkdir('.verification', { recursive: true });
  await writeFile('.verification/ssr.json', JSON.stringify(result, null, 2));
} finally {
  child.kill();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}
