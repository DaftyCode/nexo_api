// Contract tests for files sent with a request: form-data file fields and binary bodies.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { binary, startServer } from './server.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// A PNG signature and bytes that are not valid UTF-8.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
const report = Buffer.from('%PDF-1.7\né');

let server;
let echo;
before(async () => {
  server = await startServer();
  // Answers with what arrived: the fields and, for each file, its name, type and hash.
  echo = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const type = request.headers['content-type'] ?? '';
      const result = { contentType: type, sha256: sha256(body), size: body.length };
      if (type.startsWith('multipart/form-data')) {
        const form = await new Response(body, { headers: { 'content-type': type } }).formData();
        result.fields = [];
        for (const [name, value] of form.entries())
          result.fields.push(
            typeof value === 'string'
              ? { name, value }
              : {
                  name,
                  file: value.name,
                  type: value.type,
                  sha256: sha256(Buffer.from(await value.arrayBuffer())),
                },
          );
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise((resolve) => echo?.close(resolve));
  await server?.stop();
});
const url = () => `http://127.0.0.1:${echo.address().port}/upload`;

test('form-data files arrive byte for byte with their names and types', async () => {
  const result = await server.execute('request', {
    request: {
      method: 'POST',
      url: url(),
      prerequest: 'pm.environment.set("seen", JSON.stringify(pm.request.body));',
      body: {
        mode: 'formdata',
        formdata: [
          { key: 'note', value: 'hello', type: 'text' },
          { key: 'avatar', type: 'file', src: 'avatar.png' },
          { key: 'docs', type: 'file', src: ['report.pdf', 'avatar.png'] },
          { key: 'skipped', type: 'file', src: 'avatar.png', disabled: true },
        ],
      },
    },
    files: [
      { src: 'avatar.png', content: png.toString('base64'), contentType: 'image/png' },
      { src: 'report.pdf', content: report.toString('base64') },
      { src: 'avatar.png', content: png.toString('base64'), contentType: 'image/png' },
    ],
  });
  const received = JSON.parse(result.body);
  assert.match(received.contentType, /^multipart\/form-data; boundary=/);
  assert.deepEqual(received.fields, [
    { name: 'note', value: 'hello' },
    { name: 'avatar', file: 'avatar.png', type: 'image/png', sha256: sha256(png) },
    { name: 'docs', file: 'report.pdf', type: 'application/pdf', sha256: sha256(report) },
    { name: 'docs', file: 'avatar.png', type: 'image/png', sha256: sha256(png) },
  ]);
  // Neither the result nor the scripts get the contents, only the names.
  const sent = JSON.stringify(result);
  assert.ok(!sent.includes(png.toString('base64')), 'the result returns the file');
  const seen = result.variables.environment.values.find((row) => row.key === 'seen').value;
  assert.match(seen, /avatar\.png/);
  assert.ok(!seen.includes(png.toString('base64')), 'scripts see the file');
});

test('a binary body sends the exact bytes of its file', async () => {
  const result = await server.execute('request', {
    request: {
      method: 'PUT',
      url: url(),
      body: { mode: 'file', file: { src: 'photo.png' } },
    },
    files: [{ src: 'photo.png', content: png.toString('base64'), contentType: 'image/png' }],
  });
  const received = JSON.parse(result.body);
  assert.deepEqual(
    [received.contentType, received.sha256, received.size],
    ['image/png', sha256(png), png.length],
  );
  // A Content-Type of the request wins over the file's.
  const typed = await server.execute('request', {
    request: {
      method: 'POST',
      url: url(),
      headers: [{ key: 'Content-Type', value: 'application/octet-stream', enabled: true }],
      body: { mode: 'file', file: { src: 'photo.png' } },
    },
    files: [{ src: 'photo.png', content: png.toString('base64'), contentType: 'image/png' }],
  });
  assert.equal(JSON.parse(typed.body).contentType, 'application/octet-stream');
});

test('a file that was not chosen is reported and nothing is read from disk', async () => {
  const formdata = await server.execute('request', {
    request: {
      method: 'POST',
      url: url(),
      body: { mode: 'formdata', formdata: [{ key: 'avatar', type: 'file', src: 'Cargo.toml' }] },
    },
  });
  assert.equal(formdata.status, 0);
  assert.equal(formdata.error, 'Choose the file Cargo.toml for the form-data field avatar');
  const binaryBody = await server.execute('request', {
    request: { method: 'POST', url: url(), body: { mode: 'file', file: { src: 'Cargo.toml' } } },
  });
  assert.equal(binaryBody.error, 'Choose the file Cargo.toml to send as the body');
  await assert.rejects(
    server.execute('request', {
      request: { url: url() },
      files: [{ src: 'a', content: '%%%' }],
    }),
    /File a is not valid base64/,
  );
});

test('the CLI sends the files a collection references, read next to it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nexo-files-'));
  try {
    await writeFile(join(folder, 'avatar.png'), png);
    const collection = join(folder, 'upload.postman_collection.json');
    await writeFile(
      collection,
      JSON.stringify({
        info: { name: 'Upload', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
        item: [
          {
            name: 'Upload',
            request: {
              method: 'POST',
              url: url(),
              body: { mode: 'formdata', formdata: [{ key: 'a', type: 'file', src: 'avatar.png' }] },
            },
            event: [
              {
                listen: 'test',
                script: {
                  exec: [
                    `pm.test("file", () => pm.expect(pm.response.json().fields[0].sha256).to.equal("${sha256(png)}"));`,
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const cli = join(dirname(binary), `nexo-cli${process.platform === 'win32' ? '.exe' : ''}`);
    const output = await new Promise((resolve, reject) =>
      execFile(cli, ['run', collection], (error, stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout),
      ),
    );
    const run = JSON.parse(output);
    assert.equal(run.state, 'completed');
    assert.deepEqual(
      run.assertions.map((assertion) => assertion.passed),
      [true],
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
