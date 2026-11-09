// Contract tests for Kafka against a real broker. They run when one is configured (CI starts
// Redpanda with `tools/kafka-fixture.sh`) and are skipped otherwise:
//   NEXO_KAFKA_BROKERS        plaintext listener, e.g. 127.0.0.1:19092
//   NEXO_KAFKA_SASL_BROKERS   SASL listener, with NEXO_KAFKA_SASL_USER and NEXO_KAFKA_SASL_PASSWORD
//   NEXO_KAFKA_TLS_BROKERS    TLS listener, with NEXO_KAFKA_TLS_CA (a PEM file)
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer, until } from './server.mjs';

const environment = process.env;
let server;
before(async () => {
  if (environment.NEXO_KAFKA_BROKERS) server = await startServer();
});
after(async () => {
  await server?.stop();
});

const poll = (id, check) =>
  until(
    async () => {
      const polled = await server.execute('realtime.poll', { id });
      if (polled.state === 'error') throw new Error(JSON.stringify(polled.events));
      return check(polled) && polled;
    },
    { attempts: 500, delay: 40 },
  );
const of = (polled, type) => polled.events.filter((event) => event.type === type);

/** Connects, lists the topics, produces to a new topic and reads the message back. */
async function roundTrip(connection) {
  const topic = `nexo-${Math.random().toString(36).slice(2, 10)}`;
  const { id } = await server.execute('realtime.connect', { protocol: 'kafka', ...connection });
  try {
    const opened = await poll(id, (p) => of(p, 'topics').length > 0);
    assert.equal(opened.state, 'connected');
    assert.ok(Array.isArray(of(opened, 'topics')[0].data));
    await server.execute('realtime.send', {
      id,
      action: 'produce',
      topic,
      key: 'order-1',
      message: '{"total": 42}',
      headers: [{ key: 'trace', value: 't-1', enabled: true }],
    });
    const produced = await poll(id, (p) => of(p, 'produced').length > 0);
    assert.equal(of(produced, 'produced')[0].data.topic, topic);
    await server.execute('realtime.send', { id, action: 'subscribe', topic, from: 'earliest' });
    const read = await poll(id, (p) => of(p, 'message').length > 0);
    const message = of(read, 'message')[0].data;
    assert.deepEqual(
      [message.topic, message.key, message.value, message.headers],
      [topic, 'order-1', '{"total": 42}', { trace: 't-1' }],
    );
    await server.execute('realtime.send', { id, action: 'unsubscribe' });
  } finally {
    await server.execute('realtime.close', { id });
  }
}

test(
  'Kafka over plaintext: topics, produce and consume',
  { skip: !environment.NEXO_KAFKA_BROKERS && 'NEXO_KAFKA_BROKERS is not set' },
  () => roundTrip({ url: environment.NEXO_KAFKA_BROKERS }),
);

test(
  'Kafka with SASL/SCRAM and the password in the vault',
  { skip: !environment.NEXO_KAFKA_SASL_BROKERS && 'NEXO_KAFKA_SASL_BROKERS is not set' },
  async () => {
    await server.api('PUT', '/secrets/kafka', { value: environment.NEXO_KAFKA_SASL_PASSWORD });
    const sasl = {
      url: environment.NEXO_KAFKA_SASL_BROKERS,
      saslMechanism: environment.NEXO_KAFKA_SASL_MECHANISM ?? 'SCRAM-SHA-256',
      username: environment.NEXO_KAFKA_SASL_USER,
      password: '{{vault:kafka}}',
    };
    await roundTrip(sasl);
    const { id } = await server.execute('realtime.connect', {
      protocol: 'kafka',
      ...sasl,
      password: 'wrong-password',
    });
    const failed = await until(
      async () => {
        const polled = await server.execute('realtime.poll', { id });
        return polled.state === 'error' && polled;
      },
      { attempts: 500, delay: 40 },
    );
    assert.match(JSON.stringify(failed.events), /SaslAuthenticationFailed|authentication/i);
  },
);

test(
  'Kafka over TLS with a private CA',
  { skip: !environment.NEXO_KAFKA_TLS_BROKERS && 'NEXO_KAFKA_TLS_BROKERS is not set' },
  async () =>
    roundTrip({
      url: environment.NEXO_KAFKA_TLS_BROKERS,
      tls: true,
      caPem: await readFile(environment.NEXO_KAFKA_TLS_CA, 'utf8'),
    }),
);
