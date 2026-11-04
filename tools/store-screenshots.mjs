// Takes the Microsoft Store screenshots (1920×1080) in English and Spanish with sample data.
// Build first: `npm run build` and `cargo build -p nexo-server`. Output: store/screenshots.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(
  process.env.NEXO_SERVER_BINARY ??
    join(
      process.env.CARGO_TARGET_DIR ?? 'target',
      'debug',
      `nexo-server${process.platform === 'win32' ? '.exe' : ''}`,
    ),
);
const output = resolve('store/screenshots');
mkdirSync(output, { recursive: true });

const texts = {
  en: {
    collection: 'Orders API',
    folder: 'Customers',
    list: 'List customers',
    create: 'Create customer',
    order: 'Get order',
    environment: 'Production',
    workspace: 'My workspace',
    test: 'Status is 200',
  },
  es: {
    collection: 'API de pedidos',
    folder: 'Clientes',
    list: 'Listar clientes',
    create: 'Crear cliente',
    order: 'Consultar pedido',
    environment: 'Producción',
    workspace: 'Mi workspace',
    test: 'El estado es 200',
  },
};

/** A small API with realistic answers for the requests in the screenshots. */
function sampleApi() {
  const customers = [
    { id: 1042, name: 'Lucía Fernández', email: 'lucia@example.com', plan: 'pro', active: true },
    { id: 1043, name: 'Daniel Ortega', email: 'daniel@example.com', plan: 'team', active: true },
    { id: 1044, name: 'Marta Ruiz', email: 'marta@example.com', plan: 'free', active: false },
  ];
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-request-id', 'f3c1a2e4-9b7d-4c1e-8a55-2d6b0e9f7a13');
    if (request.url?.startsWith('/v1/customers') && request.method === 'GET')
      return response.end(JSON.stringify({ data: customers, total: customers.length, page: 1 }));
    if (request.url?.startsWith('/v1/customers')) {
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 1045, created: true }));
    }
    response.end(
      JSON.stringify({ id: 'A-20931', status: 'shipped', items: 3, total: 149.9, currency: 'EUR' }),
    );
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(4010, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}
const freePort = () =>
  new Promise((done) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

async function capture(language, api) {
  const t = texts[language];
  const directory = mkdtempSync(join(tmpdir(), 'nexo-store-'));
  const port = await freePort();
  const token = 'store-screenshots';
  const child = spawn(binary, ['--port', String(port), '--web', 'dist/nexo/browser', '--no-open'], {
    env: {
      ...process.env,
      NEXO_DATA_DIR: directory,
      NEXO_LOCAL_TOKEN: token,
      NEXO_MASTER_KEY: 'c'.repeat(64),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, path, body) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    }).then((r) => r.json());
  try {
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const request = (id, name, method, path, extra = {}) => ({
      id,
      name,
      request: {
        method,
        url: `{{base_url}}${path}`,
        header: [{ key: 'Accept', value: 'application/json' }],
        ...extra,
      },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              `pm.test('${t.test}', () => pm.response.to.have.status(${method === 'POST' ? 201 : 200}));`,
            ],
          },
        },
      ],
    });
    await call('PUT', '/documents', {
      id: 'orders-api',
      workspace_id: 'local',
      kind: 'collection',
      name: t.collection,
      revision: 0,
      updated_at: 0,
      value: {
        info: { name: t.collection, schema: 'urn:nexo:collection:1' },
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{vault:api_token}}' }] },
        item: [
          {
            name: t.folder,
            item: [
              request('list', t.list, 'GET', '/v1/customers?plan=pro&page=1'),
              request('create', t.create, 'POST', '/v1/customers', {
                body: {
                  mode: 'raw',
                  raw: JSON.stringify(
                    { name: 'Ana López', email: 'ana@example.com', plan: 'pro' },
                    null,
                    2,
                  ),
                  options: { raw: { language: 'json' } },
                },
              }),
            ],
          },
          request('order', t.order, 'GET', '/v1/orders/{{order_id}}'),
        ],
      },
    });
    await call('PUT', '/documents', {
      id: 'production',
      workspace_id: 'local',
      kind: 'environment',
      name: t.environment,
      revision: 0,
      updated_at: 0,
      value: {
        name: t.environment,
        values: [
          { key: 'base_url', value: `http://localhost:${api.port}`, enabled: true },
          { key: 'order_id', value: 'A-20931', enabled: true },
        ],
      },
    });
    await call('PUT', '/secrets/api_token', { value: 'sk_live_51Hx9EXAMPLE' });
    await call('PUT', '/workspaces/local', { name: t.workspace });

    const browser = await chromium.launch();
    for (const template of ['aurora', 'canvas']) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      await context.addInitScript(
        ([language, template]) => {
          localStorage.setItem('nexo.language', language);
          localStorage.setItem('nexo.appearance.template', template);
        },
        [language, template],
      );
      const page = await context.newPage();
      // The Store sells the desktop app: show the interface as the desktop window does.
      await page.route('**/api/health', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), mode: 'desktop' } });
      });
      const { path } = await call('POST', '/session/link');
      await page.goto(base + path);
      await page.waitForURL(/\/workspace/);
      await page.locator('#active-environment').selectOption({ label: t.environment });
      const name = template === 'aurora' ? t.list : t.create;
      // Canvas keeps the collection tree behind its tools button.
      if (template === 'canvas') await page.locator('.canvas-tools-toggle').click();
      await page.locator('.request-leaf', { hasText: name }).first().click();
      if (template === 'canvas' && (await page.locator('.canvas-navigation-visible').count()))
        await page.locator('.canvas-tools-toggle').click();
      // Close the empty tab opened at start.
      await page.locator('.request-tab').first().locator('.tab-close').click();
      await page.locator('button.send').first().click();
      await page
        .getByRole('status')
        .filter({ hasText: /20[01]/ })
        .first()
        .waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: join(
          output,
          `${language}-${template === 'aurora' ? '1-request' : '2-light-theme'}.png`,
        ),
      });
      if (template === 'aurora') {
        await page.locator('.rail button').nth(3).click();
        await page.locator('app-runner-panel select').first().selectOption({ label: t.collection });
        await page
          .locator('button', { hasText: /Run collection|Ejecutar colección/ })
          .last()
          .click();
        await page.locator('.run-result').first().waitFor();
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(output, `${language}-3-runner.png`) });
        await page.locator('.rail button').nth(1).click();
        await page
          .locator('.environment-list button, .environment-row', { hasText: t.environment })
          .first()
          .click()
          .catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(output, `${language}-4-environments.png`) });
      }
      await context.close();
    }
    await browser.close();
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
    rmSync(directory, { recursive: true, force: true });
  }
}

const api = await sampleApi();
try {
  for (const language of ['en', 'es']) await capture(language, api);
  console.log(`Screenshots written to ${output}`);
} finally {
  api.server.close();
}
