import { ExecutionPort } from './ports';

export interface StreamEvent {
  sequence: number;
  type: string;
  data: unknown;
  time: number;
}
export interface ConnectionState {
  id: string;
  state: string;
}
export interface ConnectionEvents {
  state: string;
  events: StreamEvent[];
}
export interface ConnectionOptions {
  protocol: string;
  url: string;
  topic?: string;
  qos?: number;
  strictSSL?: boolean;
  caPem?: string;
  username?: string;
  password?: string;
  headers?: { key: string; value: string; enabled: boolean }[];
  /** GraphQL subscriptions: the operation and the JSON text of its variables. */
  query?: string;
  variables?: string;
  /** JSON text of the `connection_init` payload. */
  connectionParams?: string;
  graphqlProtocol?: string;
  /** Socket.IO: `auto`, `websocket` or `polling`. */
  transports?: string;
  /** Kafka: TLS, and SASL with `PLAIN`, `SCRAM-SHA-256` or `SCRAM-SHA-512`. */
  tls?: boolean;
  saslMechanism?: string;
}
export interface RealtimeMessage {
  action: string;
  message: string;
  topic: string;
  event: string;
  qos: number;
  /** Kafka: the record key, its partition and headers, and where reading starts. */
  key?: string;
  partition?: number;
  headers?: { key: string; value: string; enabled: boolean }[];
  from?: 'earliest' | 'latest' | 'offset';
  offset?: number;
}
export interface GrpcCall {
  url: string;
  proto: string;
  /** The server describes its services (`grpc.reflection.v1` or `v1alpha`): no proto. */
  reflection?: boolean;
  service: string;
  method: string;
  tls: boolean;
  caPem?: string;
  /** JSON text of the request message. */
  message: string;
  /** JSON text of the metadata rows. */
  metadata: string;
}

/** A method of a discovered service. */
export interface GrpcMethod {
  name: string;
  input: string;
  output: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}
/** The services of a proto or a server, with their methods. */
export interface GrpcDiscovery {
  services: string[];
  methods: Record<string, GrpcMethod[]>;
  /** The reflection version the server answered, when discovered by reflection. */
  reflection?: string;
}

function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

/** WebSocket, Socket.IO and MQTT connections, and gRPC calls. */
export class ProtocolUseCases {
  constructor(private readonly api: ExecutionPort) {}

  connect(workspace: string, options: ConnectionOptions) {
    return this.api.execute<ConnectionState>('realtime.connect', { workspace, ...options });
  }
  /** Events after `after`, with the connection state. */
  poll(workspace: string, id: string, after: number) {
    return this.api.execute<ConnectionEvents>('realtime.poll', { workspace, id, after });
  }
  send(workspace: string, id: string, message: RealtimeMessage) {
    if (!id) throw new Error('Connection is not open');
    return this.api.execute('realtime.send', { workspace, id, ...message });
  }
  close(workspace: string, id: string) {
    return this.api.execute('realtime.close', { workspace, id });
  }
  async grpc(workspace: string, call: GrpcCall) {
    const { message, metadata, caPem, proto, reflection, ...rest } = call;
    return this.api.execute<unknown>('grpc', {
      workspace,
      ...rest,
      ...(reflection ? { reflection: true } : { proto }),
      ...(caPem?.trim() ? { caPem } : {}),
      message: json(message, 'The request message'),
      metadata: json(metadata || '[]', 'Metadata'),
    });
  }
  /** Lists the services and methods of the proto, or of the server by reflection. */
  discoverGrpc(
    workspace: string,
    call: Pick<GrpcCall, 'url' | 'proto' | 'reflection' | 'tls' | 'caPem' | 'metadata'>,
  ) {
    if (call.reflection && !call.url.trim())
      throw new Error('Enter the gRPC server address (host:port)');
    return this.api.execute<GrpcDiscovery>('grpc', {
      workspace,
      ...(call.reflection
        ? { reflection: true, url: call.url, tls: call.tls }
        : { proto: call.proto }),
      ...(call.caPem?.trim() ? { caPem: call.caPem } : {}),
      metadata: json(call.metadata || '[]', 'Metadata'),
    });
  }
}
