import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import mqtt from 'mqtt';
import { io } from 'socket.io-client';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateUrl } from '../domain/collection.mjs';

export class RealtimeAdapter {
  #sessions = new Map();
  #get(actor, id) {
    const session = this.#sessions.get(`${actor}:${id}`);
    if (!session) throw new Error('Connection not found');
    return session;
  }
  connect(actor, payload) {
    if ([...this.#sessions.keys()].filter((x) => x.startsWith(`${actor}:`)).length >= 16)
      throw new Error('Connection limit reached');
    const id = randomUUID(),
      events = [];
    const session = {
      id,
      protocol: payload.protocol,
      state: 'connecting',
      events,
      sequence: 0,
      client: undefined,
    };
    const emit = (type, data) => {
      events.push({ sequence: ++session.sequence, type, data, time: Date.now() });
      if (events.length > 1000) events.shift();
    };
    this.#sessions.set(`${actor}:${id}`, session);
    if (payload.protocol === 'websocket') {
      validateUrl(payload.url, ['ws:', 'wss:']);
      const client = new WebSocket(payload.url, payload.subprotocols ?? [], {
        headers: Object.fromEntries(
          (payload.headers ?? [])
            .filter((x) => x.enabled !== false && x.key)
            .map((x) => [x.key, x.value]),
        ),
        handshakeTimeout: 15000,
        maxPayload: 8 * 1024 * 1024,
      });
      session.client = client;
      client.on('open', () => {
        session.state = 'connected';
        emit('open', 'Connected');
      });
      client.on('message', (data, isBinary) =>
        emit('message', {
          text: isBinary ? data.toString('base64') : data.toString(),
          binary: isBinary,
        }),
      );
      client.on('error', (error) => {
        session.state = 'error';
        emit('error', error.message);
      });
      client.on('close', (code, reason) => {
        session.state = 'closed';
        emit('close', { code, reason: reason.toString() });
      });
    } else if (payload.protocol === 'mqtt') {
      validateUrl(payload.url, ['mqtt:', 'mqtts:', 'ws:', 'wss:']);
      const client = mqtt.connect(payload.url, {
        clientId: payload.clientId ?? `nexo-${id}`,
        username: payload.username,
        password: payload.password,
        connectTimeout: 15000,
        reconnectPeriod: 0,
        protocolVersion: payload.version ?? 4,
        clean: payload.clean !== false,
      });
      session.client = client;
      client.on('connect', () => {
        session.state = 'connected';
        emit('open', 'Connected');
        if (payload.topic) client.subscribe(payload.topic, { qos: payload.qos ?? 0 });
      });
      client.on('message', (topic, body, packet) =>
        emit('message', { topic, text: body.toString(), qos: packet.qos, retain: packet.retain }),
      );
      client.on('error', (error) => emit('error', error.message));
      client.on('close', () => {
        session.state = 'closed';
        emit('close', 'Disconnected');
      });
    } else if (payload.protocol === 'socketio') {
      validateUrl(payload.url);
      const client = io(payload.url, {
        autoConnect: false,
        timeout: 15000,
        reconnection: false,
        auth: payload.auth ?? {},
        path: payload.path ?? '/socket.io',
      });
      session.client = client;
      client.on('connect', () => {
        session.state = 'connected';
        emit('open', client.id);
      });
      client.onAny((event, ...data) => emit('message', { event, data }));
      client.on('connect_error', (error) => {
        session.state = 'error';
        emit('error', error.message);
      });
      client.on('disconnect', (reason) => {
        session.state = 'closed';
        emit('close', reason);
      });
      client.connect();
    } else {
      this.#sessions.delete(`${actor}:${id}`);
      throw new Error('Select WebSocket, Socket.IO or MQTT');
    }
    return { id, state: session.state };
  }
  send(actor, payload) {
    const session = this.#get(actor, payload.id);
    if (session.state !== 'connected') throw new Error('Connection is not open');
    if (session.protocol === 'websocket') session.client.send(payload.message ?? '');
    if (session.protocol === 'mqtt') {
      if (payload.action === 'subscribe')
        session.client.subscribe(payload.topic, { qos: payload.qos ?? 0 });
      else if (payload.action === 'unsubscribe') session.client.unsubscribe(payload.topic);
      else
        session.client.publish(payload.topic, payload.message ?? '', {
          qos: payload.qos ?? 0,
          retain: !!payload.retain,
        });
    }
    if (session.protocol === 'socketio') {
      let value = payload.message;
      try {
        value = JSON.parse(value);
      } catch {}
      session.client.emit(payload.event ?? 'message', value);
    }
    return { sent: true };
  }
  poll(actor, payload) {
    const session = this.#get(actor, payload.id);
    return {
      id: session.id,
      state: session.state,
      events: session.events.filter((x) => x.sequence > (payload.after ?? 0)),
    };
  }
  disconnect(actor, payload) {
    const session = this.#get(actor, payload.id);
    if (session.protocol === 'mqtt') session.client.end(true);
    else if (session.protocol === 'socketio') session.client.disconnect();
    else session.client.terminate();
    this.#sessions.delete(`${actor}:${payload.id}`);
    return { closed: true };
  }
  close() {
    for (const session of this.#sessions.values()) {
      session.client?.terminate?.();
      session.client?.end?.(true);
      session.client?.disconnect?.();
    }
  }
}

export async function grpcRequest(_, payload) {
  if (!payload.proto?.trim()) throw new Error('Provide a .proto service definition');
  if (payload.proto.length > 2 * 1024 * 1024) throw new Error('Proto definition is too large');
  // Caller supplies source, never a server filesystem path. Builtin google protos are resolved by proto-loader.
  if (/import\s+["'](?!google\/protobuf\/)[^"']+["']/.test(payload.proto))
    throw new Error('Inline non-google proto imports into the definition');
  const directory = await mkdtemp(join(tmpdir(), 'nexo-proto-'));
  try {
    const path = join(directory, 'request.proto');
    await writeFile(path, payload.proto);
    const definition = loader.loadSync(path, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const object = grpc.loadPackageDefinition(definition);
    let Service = object;
    for (const part of (payload.service ?? '').split('.')) Service = Service?.[part];
    if (typeof Service !== 'function')
      return {
        services: Object.keys(definition).filter(
          (x) => definition[x]?.[Object.keys(definition[x])[0]]?.path,
        ),
      };
    const client = new Service(
      payload.url,
      payload.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    );
    const method = client[payload.method];
    if (typeof method !== 'function') throw new Error('gRPC method not found');
    const metadata = new grpc.Metadata();
    for (const h of payload.metadata ?? []) if (h.key) metadata.add(h.key, h.value);
    return await new Promise((resolve, reject) => {
      const started = Date.now(),
        messages = [];
      const methodDef = Service.service[payload.method];
      const options = { deadline: Date.now() + Math.min(payload.timeout ?? 30000, 120000) };
      let call;
      if (methodDef?.responseStream) {
        call = method.call(
          client,
          ...(methodDef.requestStream ? [] : [payload.message ?? {}]),
          metadata,
          options,
        );
        call.on('data', (message) => messages.push(message));
        call.on('error', (error) => {
          client.close();
          reject(error);
        });
        call.on('end', () => {
          client.close();
          resolve({ messages, time: Date.now() - started, status: 0 });
        });
      } else
        call = method.call(
          client,
          ...(methodDef?.requestStream ? [] : [payload.message ?? {}]),
          metadata,
          options,
          (error, message) => {
            client.close();
            error ? reject(error) : resolve({ message, time: Date.now() - started, status: 0 });
          },
        );
      if (methodDef?.requestStream) {
        for (const message of payload.messages ?? [payload.message ?? {}]) call.write(message);
        call.end();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
