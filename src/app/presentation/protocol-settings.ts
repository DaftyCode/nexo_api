import { emptyRoute } from '../domain/route';

/** The settings of a protocol connection, as the panel starts them. */
export const defaultProtocolSettings = {
  protocol: 'websocket',
  url: 'ws://localhost:9001',
  message: 'Hello from Nexo',
  grpcMessage: '{\n  "name": "Nexo"\n}',
  topic: 'nexo/demo',
  event: 'message',
  proto:
    'syntax = "proto3";\npackage demo;\nservice Greeter { rpc Hello (HelloRequest) returns (HelloReply); }\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }',
  service: 'demo.Greeter',
  method: 'Hello',
  metadata: '[]',
  tls: false,
  strictSSL: true,
  caPem: '',
  username: '',
  password: '',
  qos: '0',
  query: 'subscription {\n  \n}',
  variables: '{}',
  connectionParams: '{}',
  graphqlProtocol: 'graphql-transport-ws',
  reflection: false,
  transports: 'auto',
  saslMechanism: 'none',
  key: '',
  partition: '',
  from: 'latest',
  offset: '',
  mongoConnection: '',
  database: '',
  collection: '',
  pipeline: '[]',
  fullDocument: 'default',
  fullDocumentBeforeChange: 'off',
  resumeAfter: '',
  /** A Redis subscription (DB-35): the saved connection, its channels and patterns. */
  redisConnection: '',
  channels: 'news',
  patterns: '',
  /** How the connection reaches its server: directly, a proxy or an SSH tunnel. */
  route: emptyRoute(),
};

export type ProtocolSettings = typeof defaultProtocolSettings;
