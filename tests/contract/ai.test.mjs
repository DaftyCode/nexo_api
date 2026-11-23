// Contract tests of the AI assistant (IA-01) through Nexo, against a provider played on
// loopback: the key comes from the vault, a value of the vault never reaches the provider,
// the answer streams and is read by polls, its reasoning apart, it reads with tools whose
// answers go back masked, it can be stopped, and the models are listed. Without a key
// nothing is called.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, until } from './server.mjs';

let server;
let provider;
let address;
const received = [];
/** How the provider answers the next chat: its events and the pause between them. */
let script = { events: [], pause: 0 };
/** Scripts for the chats that come next, one each, before `script` again. */
let queue = [];

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const text = (value) =>
  sse('content_block_delta', {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: value },
  });

before(async () => {
  provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }],
            has_more: false,
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const answer = queue.shift() ?? script;
      for (const event of answer.events) {
        if (response.destroyed) return;
        response.write(event);
        await new Promise((wait) => setTimeout(wait, answer.pause));
      }
      response.end();
    });
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  address = `http://127.0.0.1:${provider.address().port}/v1`;
  server = await startServer();
});
after(async () => {
  await server?.stop();
  provider?.close();
});

const chat = (question) =>
  server.api('POST', '/execute/ai.chat', {
    workspace: 'local',
    provider: 'anthropic',
    baseUrl: address,
    model: 'claude-opus-5-5',
    system: 'Be brief',
    messages: [{ role: 'user', text: question }],
  });
async function answer(id) {
  let written = '';
  let thinking = '';
  let after = 0;
  let thinkingAfter = 0;
  let last;
  await until(async () => {
    const polled = await server.execute('ai.poll', { id, after, thinkingAfter });
    written += polled.text;
    thinking += polled.thinking;
    after = polled.next;
    thinkingAfter = polled.thinkingNext;
    last = polled;
    return polled.done;
  });
  return { written, thinking, last };
}

test('without a key nothing is called', async () => {
  const refused = await chat('Hello');
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /API key/);
  assert.equal(received.length, 0);
});

test('the key comes from the vault and a value of the vault never leaves', async () => {
  await server.api('PUT', '/secrets/ai:anthropic', { value: 'sk-contract-key' });
  await server.api('PUT', '/secrets/db-password', { value: 'hunter2-secret' });
  script = {
    events: [
      sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 9 } } }),
      text('Hola '),
      text('desde el proveedor.'),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }),
    ],
    pause: 5,
  };
  const started = await chat('Why does hunter2-secret fail?');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { written, last } = await answer(started.body.id);
  assert.equal(written, 'Hola desde el proveedor.');
  assert.equal(last.stop, 'end_turn');
  assert.deepEqual(last.usage, { input: 9, output: 5 });
  const sent = received.at(-1);
  assert.equal(sent.url, '/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-contract-key');
  assert.equal(sent.headers['anthropic-version'], '2026-10-21');
  assert.ok(!sent.body.includes('hunter2-secret'), sent.body);
  assert.match(sent.body, /\[redacted\]/);
  // The key is not in the answer either.
  assert.ok(!JSON.stringify(last).includes('sk-contract-key'));
});

test('the reasoning streams apart from the answer', async () => {
  const thought = (value) =>
    sse('content_block_delta', {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: value },
    });
  script = { events: [thought('Count rows '), thought('by client.'), text('GROUP BY')], pause: 5 };
  const started = await chat('Count');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { written, thinking } = await answer(started.body.id);
  assert.equal(written, 'GROUP BY');
  assert.equal(thinking, 'Count rows by client.');
  // Claude is asked for a summary of its thinking, which it omits otherwise.
  assert.deepEqual(JSON.parse(received.at(-1).body).thinking, {
    type: 'adaptive',
    display: 'summarized',
  });

  // llama.cpp and the servers compatible with OpenAI send it without being asked.
  const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  script = {
    events: [chunk({ reasoning_content: 'Plan.' }), chunk({ content: 'Done' }), 'data: [DONE]\n\n'],
    pause: 5,
  };
  const compatible = await server.api('POST', '/execute/ai.chat', {
    workspace: 'local',
    provider: 'compatible',
    baseUrl: address,
    model: 'qwen',
    messages: [{ role: 'user', text: 'Plan' }],
  });
  assert.equal(compatible.status, 200, JSON.stringify(compatible.body));
  const local = await answer(compatible.body.id);
  assert.equal(local.written, 'Done');
  assert.equal(local.thinking, 'Plan.');
  assert.equal(received.at(-1).url, '/v1/chat/completions');
});

test('the model reads with tools and their answers go back masked', async () => {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
  const call = { index: 0, id: 'call_1', type: 'function' };
  queue = [
    {
      events: [
        chunk({ tool_calls: [{ ...call, function: { name: 'read_open', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls'),
        'data: [DONE]\n\n',
      ],
      pause: 5,
    },
    { events: [chunk({ content: 'It logs in.' }, 'stop'), 'data: [DONE]\n\n'], pause: 5 },
  ];
  const started = await server.api('POST', '/execute/ai.chat', {
    workspace: 'local',
    provider: 'compatible',
    baseUrl: address,
    model: 'qwen',
    tools: 'request',
    messages: [{ role: 'user', text: 'What does this request do?' }],
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const id = started.body.id;
  let waiting;
  await until(async () => {
    waiting = await server.execute('ai.poll', { id });
    return waiting.tools?.length > 0;
  });
  assert.deepEqual(waiting.tools, [{ id: 'call_1', name: 'read_open', input: {} }]);
  const offered = JSON.parse(received.at(-1).body).tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('read_open') && offered.includes('read_response'), offered);
  // The tool reads what is open as agents may: no credential, no value of the vault.
  const read = await server.execute('ai.tool', {
    workspace: 'local',
    name: 'read_open',
    context: {
      place: 'request',
      request: {
        name: 'Login',
        request: {
          method: 'POST',
          url: 'https://api.test/login',
          header: [{ key: 'Authorization', value: 'Bearer abc' }],
          body: { mode: 'raw', raw: 'pass=hunter2-secret' },
        },
      },
    },
  });
  assert.equal(read.error, false);
  assert.ok(read.text.includes('https://api.test/login'), read.text);
  assert.ok(!read.text.includes('Bearer abc') && !read.text.includes('hunter2-secret'), read.text);
  const refused = await server.execute('ai.tool', {
    workspace: 'local',
    name: 'sql_query',
    input: { connection: 'Prod', sql: 'SELECT 1' },
  });
  assert.equal(refused.error, true);
  await server.execute('ai.continue', {
    id,
    results: [{ id: 'call_1', text: `${read.text} and hunter2-secret` }],
  });
  const { written, last } = await answer(id);
  assert.equal(written, 'It logs in.');
  assert.equal(last.stop, 'stop');
  const sent = received.at(-1).body;
  const messages = JSON.parse(sent).messages;
  assert.equal(messages.at(-2).tool_calls[0].id, 'call_1');
  assert.deepEqual(
    { role: messages.at(-1).role, id: messages.at(-1).tool_call_id },
    { role: 'tool', id: 'call_1' },
  );
  assert.ok(!sent.includes('hunter2-secret'), sent);
});

test('an answer is stopped where it is', async () => {
  script = { events: [text('One. '), text('Two. '), text('Three. '), text('Four.')], pause: 400 };
  const started = await chat('Count');
  assert.equal(started.status, 200);
  await until(async () => received.at(-1)?.url === '/v1/messages');
  await new Promise((wait) => setTimeout(wait, 150));
  const stopped = await server.execute('ai.stop', { id: started.body.id });
  assert.equal(stopped.stopped, true);
  const { written, last } = await answer(started.body.id);
  assert.equal(last.stop, 'stopped');
  assert.ok(!written.includes('Four'), written);
});

test('the models of the provider are listed', async () => {
  const listed = await server.execute('ai.models', { provider: 'anthropic', baseUrl: address });
  assert.deepEqual(listed.models, [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]);
  assert.match(received.at(-1).url, /^\/v1\/models\?limit=1000/);
});
