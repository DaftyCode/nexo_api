import { CookieJar } from 'tough-cookie';
import { randomUUID } from 'node:crypto';
import { HttpTransport } from './transport.mjs';
import { ScriptSession } from './scripts.mjs';

const send = (message) => process.send?.(message);
function values(rows = []) {
  return Object.fromEntries(
    rows
      .filter((row) => row.enabled !== false && !row.disabled && row.key)
      .map((row) => [row.key, row.value ?? '']),
  );
}
function flatten(group, parents = []) {
  return (group.item ?? []).flatMap((item) =>
    item.item ? flatten(item, [...parents, group]) : [{ item, parents: [...parents, group] }],
  );
}
process.once('message', async (payload) => {
  const results = [],
    assertions = [],
    logs = [];
  const started = Date.now();
  let environment = values(payload.variables);
  let globals = values(payload.globals);
  const secrets = Object.fromEntries(
    Object.entries(payload.resolvedSecrets ?? {}).map(([key, value]) => [`vault:${key}`, value]),
  );
  const jar = payload.cookieJar ? CookieJar.deserializeSync(payload.cookieJar) : new CookieJar();
  const transport = new HttpTransport(payload, jar);
  let failure;
  try {
    const items = flatten(payload.collection);
    const iterations = Math.min(Math.max(Number(payload.iterations) || 1, 1), 10000);
    const local = {};
    const deadline = started + Math.min(payload.globalTimeout ?? 300000, 3600000);
    outer: for (let iteration = 0; iteration < iterations; iteration++) {
      for (let index = 0, steps = 0; index < items.length; index++, steps++) {
        if (Date.now() > deadline || steps > 10000)
          throw new Error('Execution exceeded time limit');
        const { item, parents } = items[index];
        const inherited = [...parents, item];
        const request = structuredClone(
          typeof item.request === 'string'
            ? { method: 'GET', url: item.request }
            : (item.request ?? {}),
        );
        request.auth ??= [...inherited].reverse().find((group) => group.auth)?.auth;
        const collectionVariables = Object.assign(
          {},
          ...inherited.map((group) => values(group.variable)),
        );
        const session = new ScriptSession(
          {
            environment,
            globals,
            local,
            collection: collectionVariables,
            data: payload.data?.[iteration] ?? {},
            secrets,
            request,
            iteration,
            iterationCount: iterations,
            requestName: item.name,
            requestId: item.id,
            uuid: randomUUID(),
          },
          (request) => transport.request(request),
        );
        const scripts = (kind) =>
          inherited.flatMap((group) =>
            (group.event ?? [])
              .filter((event) => event.listen === kind)
              .map((event) => event.script?.exec ?? []),
          );
        await session.run(scripts('prerequest'));
        let state = session.snapshot();
        if (!state.skip) {
          const url = session.replaceUrl(state.request.url);
          const outgoing = session.replace(state.request);
          outgoing.url = url;
          let result;
          try {
            result = await transport.request(outgoing);
          } catch (error) {
            result = {
              url,
              method: outgoing.method,
              status: 0,
              statusText: '',
              body: '',
              headers: [],
              cookies: [],
              size: 0,
              time: 0,
              error: error.message,
            };
            failure ??= error.message;
          }
          Object.assign(result, {
            id: item.id,
            name: item.name ?? url,
            iteration,
            request: outgoing,
          });
          results.push(result);
          send({ type: 'request', result });
          await session.run(scripts('test').reverse(), result);
        }
        state = session.snapshot();
        environment = state.environment;
        globals = state.globals;
        Object.assign(local, state.local);
        Object.assign(payload.collection, {
          variable: Object.entries(state.collection).map(([key, value]) => ({ key, value })),
        });
        for (const assertion of state.assertions) {
          assertions.push(assertion);
          send({ type: 'assertion', assertion });
        }
        logs.push(...state.logs.slice(0, Math.max(0, 1000 - logs.length)));
        if (state.next === null) break outer;
        if (typeof state.next === 'string') {
          const next = items.findIndex(
            ({ item }) => item.id === state.next || item.name === state.next,
          );
          if (next < 0) throw new Error('Next request was not found');
          index = next - 1;
        }
      }
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await transport.close();
    send({
      type: 'done',
      error: failure,
      results,
      assertions,
      logs,
      duration: Date.now() - started,
      environment: {
        values: Object.entries(environment).map(([key, value]) => ({ key, value, enabled: true })),
      },
      cookieJar: jar.serializeSync(),
    });
    setTimeout(() => process.exit(0), 10);
  }
});
