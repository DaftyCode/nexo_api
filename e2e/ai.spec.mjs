// End-to-end test of the AI assistant (IA-01) against a server compatible with OpenAI's API,
// played by the test: it is set up in Settings → AI assistant (off until then), its models
// are listed, and a question asked beside a request reads the request with a tool, streams
// its answer, and its tests go into the request. axe finds nothing serious in either place.
import { createServer } from 'node:http';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

const TEST = 'pm.test("answers", () => pm.response.to.have.status(200));';

test('the assistant is set up and answers beside a request', async ({ page, nexo }) => {
  const asked = [];
  const provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
        return;
      }
      const sent = JSON.parse(body);
      asked.push(sent);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish) =>
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`,
        );
      // First it reads what is open; with that, it answers.
      if (sent.messages.at(-1).role !== 'tool') {
        const call = { name: 'read_open', arguments: '{}' };
        send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: call }] });
        response.end('data: [DONE]\n\n');
        return;
      }
      const pieces = ['Hola ', 'desde ', 'el servidor.\n```javascript\n', TEST, '\n```'];
      for (const piece of pieces) {
        send({ content: piece });
        await new Promise((wait) => setTimeout(wait, 50));
      }
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  const address = `http://127.0.0.1:${provider.address().port}/v1`;
  try {
    await nexo.signIn(page);
    const sections = page.getByRole('navigation', { name: 'Workspace sections' });
    await sections.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'AI assistant', exact: true }).click();
    await expect(page.getByText('What leaves your computer')).toBeVisible();
    await page.getByLabel('Use the AI assistant').check();
    await page.getByLabel('Provider').selectOption('compatible');
    await page.getByLabel('Address of the server').fill(address);
    await page.getByRole('button', { name: 'List the models' }).click();
    await expect(page.getByText('The provider lists 1 models.')).toBeVisible();
    await page.getByLabel('Model', { exact: true }).fill('local-model');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await violations(page)).toEqual([]);

    await sections.getByRole('button', { name: 'Collections' }).click();
    await page.getByRole('button', { name: 'AI assistant', exact: true }).click();
    const chat = page.getByRole('complementary', { name: 'AI assistant' });
    await chat.getByLabel('Ask the assistant').fill('¿Qué devuelve esta petición?');
    await chat.getByLabel('Ask the assistant').press('Enter');
    await expect(chat.getByRole('log')).toContainText('Hola desde el servidor.');
    await expect(chat.getByRole('log')).toContainText('Read what is open');
    expect(asked[0].model).toBe('local-model');
    expect(asked[0].messages.at(-1)).toEqual({
      role: 'user',
      content: '¿Qué devuelve esta petición?',
    });
    expect(asked[0].messages[0].role).toBe('system');
    expect(asked[0].tools.map((tool) => tool.function.name)).toContain('read_response');
    // The request open went back to the model, read as agents may read it.
    expect(asked[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(asked[1].messages.at(-1).content).toContain('"request"');
    expect(await violations(page)).toEqual([]);
    await chat.getByRole('button', { name: 'Add to the tests' }).click();
    await expect(page.getByRole('strong').filter({ hasText: 'Added to the tests' })).toBeVisible();
    await chat.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Scripts', exact: true }).click();
    await expect(page.getByText('pm.response.to.have.status(200)')).toBeVisible();
  } finally {
    provider.close();
  }
});
