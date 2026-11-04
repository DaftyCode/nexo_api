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
}
export interface RealtimeMessage {
  action: string;
  message: string;
  topic: string;
  event: string;
  qos: number;
}
export interface GrpcCall {
  url: string;
  proto: string;
  service: string;
  method: string;
  tls: boolean;
  caPem?: string;
  /** JSON text of the request message. */
  message: string;
  /** JSON text of the metadata rows. */
  metadata: string;
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
    const { message, metadata, caPem, ...rest } = call;
    return this.api.execute<unknown>('grpc', {
      workspace,
      ...rest,
      ...(caPem?.trim() ? { caPem } : {}),
      message: json(message, 'The request message'),
      metadata: json(metadata || '[]', 'Metadata'),
    });
  }
}
