// End-to-end test of the AI assistant (IA-01) against a server compatible with OpenAI's API,
// played by the test: it is set up in Settings → AI assistant (off until then), its models
// are listed, and a question asked beside a request streams its answer. axe finds nothing
// serious in either place.
import { createServer } from 'node:http';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

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
      asked.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['Hola ', 'desde ', 'el servidor.']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise((wait) => setTimeout(wait, 50));
      }
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
    expect(asked[0].model).toBe('local-model');
    expect(asked[0].messages.at(-1)).toEqual({
      role: 'user',
      content: '¿Qué devuelve esta petición?',
    });
    expect(asked[0].messages[0].role).toBe('system');
    expect(await violations(page)).toEqual([]);
  } finally {
    provider.close();
  }
});
