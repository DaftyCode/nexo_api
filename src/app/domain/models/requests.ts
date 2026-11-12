/** Requests as the interface edits them: rows, files, protocols, settings and responses. */

import { AuthDraft } from '../auth';

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  /** Form-data rows: `file` sends files instead of text, as in Postman. */
  type?: 'text' | 'file';
  /** Form-data file rows: the names of their files, as collections store them. */
  src?: string | string[];
  /** Form-data rows: the media type of the part. */
  contentType?: string;
  /** Form-data file rows: the files chosen in this session; never saved. */
  files?: AttachedFile[];
}
/**
 * A file chosen to send with a request. Its content stays in the open request only:
 * collections, history and exports keep its name, as in Postman.
 */
export interface AttachedFile {
  name: string;
  contentType: string;
  size: number;
  /** Base64. */
  content: string;
}
/** A file as the engine receives it to send: the name it was chosen for and its content. */
export interface FileUpload {
  src: string;
  content: string;
  contentType?: string;
}
/** The most a request may send in files. */
export const MAX_REQUEST_FILES = 32 * 1024 * 1024;
export type Protocol =
  | 'http'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'socketio'
  | 'mqtt'
  | 'graphql-subscription'
  | 'kafka';
export interface RequestDraft {
  id: string;
  name: string;
  protocol: Protocol;
  method: string;
  url: string;
  headers: KeyValue[];
  query: KeyValue[];
  /** Values of the `:name` segments of the URL (Postman "Path Variables"). */
  pathVariables: KeyValue[];
  form: KeyValue[];
  body: string;
  bodyMode: string;
  /** Binary body (`bodyMode` `file`): the file's name and, once chosen, its content. */
  bodyFile?: { src: string; file?: AttachedFile };
  bodyLanguage: string;
  graphqlVariables: string;
  auth: AuthDraft;
  prerequest: string;
  tests: string;
  timeout: number;
  strictSSL: boolean;
  followRedirects: boolean;
  transport: string;
  /** WebSocket, Socket.IO, MQTT, gRPC and GraphQL subscription settings of the protocols panel. */
  realtime?: RealtimeSettings;
}
export interface RealtimeSettings {
  protocol: 'websocket' | 'socketio' | 'mqtt' | 'grpc' | 'graphql-subscription' | 'kafka';
  url: string;
  message: string;
  grpcMessage: string;
  topic: string;
  event: string;
  proto: string;
  service: string;
  method: string;
  metadata: string;
  tls: boolean;
  strictSSL: boolean;
  caPem: string;
  username: string;
  password: string;
  qos: string;
  headers: KeyValue[];
  /** GraphQL subscriptions: the operation, its variables and `connection_init` payload (JSON). */
  query?: string;
  variables?: string;
  connectionParams?: string;
  /** `graphql-transport-ws` (current) or `graphql-ws` (`subscriptions-transport-ws`). */
  graphqlProtocol?: string;
  /** gRPC: the server describes its services by reflection; no descriptors are saved. */
  reflection?: boolean;
  /** Socket.IO: `auto` (long polling, then WebSocket), `websocket` or `polling`. */
  transports?: string;
  /** Kafka: SASL mechanism, record key and partition, and where reading starts. */
  saslMechanism?: string;
  key?: string;
  partition?: string;
  from?: string;
  offset?: string;
}
const realtimeProtocols = [
  'websocket',
  'socketio',
  'mqtt',
  'grpc',
  'graphql-subscription',
  'kafka',
];
const isReference = (value: string) => /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
/** Realtime settings as stored in a collection: literal passwords are never written. */
export function storedRealtime(settings: RealtimeSettings): RealtimeSettings {
  return { ...settings, password: isReference(settings.password) ? settings.password : '' };
}
export function readRealtime(value: unknown): RealtimeSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const settings = value as RealtimeSettings;
  return realtimeProtocols.includes(settings.protocol) ? settings : undefined;
}
export interface Assertion {
  name: string;
  passed: boolean;
  skipped: boolean;
  error?: string;
  iteration?: number;
  /** Name of the request whose scripts ran the test. */
  request?: string;
}
export interface ExecutionResponse {
  status: number;
  statusText: string;
  body: string;
  headers: KeyValue[];
  time: number;
  size: number;
  assertions: Assertion[];
  logs: { level: string; values: string[] }[];
  error?: string;
  truncated?: boolean;
  /** `base64` when the body is binary (images, archives, PDFs). */
  bodyEncoding?: 'base64';
  warnings?: string[];
  cookies?: unknown[];
  request?: unknown;
  executionId?: string;
  /** Final value of each variable scope after the request scripts ran. */
  variables?: { environment?: unknown; globals?: unknown; collection?: unknown };
}
