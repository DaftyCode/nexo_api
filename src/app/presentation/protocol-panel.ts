import { TranslocoPipe } from '@jsverse/transloco';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  DestroyRef,
  effect,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { PanelTask } from './panel-task';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, RealtimeSettings, row } from '../domain/models';
import { GrpcDiscovery, StreamEvent } from '../application/protocol-use-cases';
import { PROTOCOLS } from '../composition/providers';
import { CodeEditor } from './code-editor';

@Component({
  imports: [TranslocoPipe, FormField, KeyValueEditor, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-protocol-panel',
  styleUrl: './protocol-panel.scss',
  templateUrl: './protocol-panel.html',
})
export class ProtocolPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  private readonly protocols = inject(PROTOCOLS);
  private readonly destroy = inject(DestroyRef);
  protected readonly model = signal({
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
  });
  protected readonly fields = form(this.model);
  protected readonly headers = signal<KeyValue[]>([row()]);
  protected readonly connection = signal('');
  protected readonly status = signal('disconnected');
  protected readonly events = signal<StreamEvent[]>([]);
  protected readonly result = signal('');
  /** How a Socket.IO message writes binary data. */
  protected readonly binaryExample = '{"$binary": "<base64>"}';
  /** How a Kafka password refers to a vault secret. */
  protected readonly vaultExample = '{{vault:name}}';
  /** Services found for each server address (reflection) or proto, during the session. */
  private readonly discoveries = signal<Readonly<Record<string, GrpcDiscovery>>>({});
  private discoveryKey() {
    const m = this.model();
    return m.reflection ? `reflection:${m.url.trim()}` : `proto:${m.proto}`;
  }
  /** A message that looks like JSON is coloured as JSON. */
  protected readonly messageLanguage = computed(() =>
    /^\s*[{[]/.test(this.model().message) ? 'json' : 'text',
  );
  protected readonly discovery = computed<GrpcDiscovery | undefined>(
    () => this.discoveries()[this.discoveryKey()],
  );
  protected readonly methods = computed(
    () => this.discovery()?.methods[this.model().service] ?? [],
  );
  protected readonly streaming = computed(() => {
    const method = this.methods().find((item) => item.name === this.model().method);
    if (!method) return '';
    if (method.clientStreaming && method.serverStreaming) return 'Bidirectional streaming';
    if (method.clientStreaming) return 'Client streaming';
    if (method.serverStreaming) return 'Server streaming';
    return 'Unary';
  });
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Tab whose saved settings were loaded into the panel. */
  private loadedTab = '';
  constructor() {
    // A saved protocol request opens with its settings.
    effect(() => {
      const tab = this.state.active();
      const settings = tab?.request.realtime;
      if (!tab || !settings || tab.id === this.loadedTab) return;
      this.loadedTab = tab.id;
      const { headers, ...model } = settings;
      untracked(() => {
        this.model.set({ ...this.model(), ...model });
        this.headers.set(headers?.length ? headers : [row()]);
      });
    });
    this.destroy.onDestroy(() => {
      clearTimeout(this.timer);
      if (this.connection())
        void this.protocols.close(this.state.workspaceId(), this.connection()).catch(() => {});
    });
  }
  private options() {
    const m = this.model();
    return {
      protocol: m.protocol,
      url: m.url,
      topic: m.topic,
      qos: Number(m.qos),
      strictSSL: m.strictSSL,
      ...(m.caPem.trim() ? { caPem: m.caPem } : {}),
      ...(m.protocol === 'mqtt' ? { username: m.username, password: m.password } : {}),
      ...(m.protocol === 'kafka'
        ? {
            tls: m.tls,
            saslMechanism: m.saslMechanism,
            ...(m.saslMechanism !== 'none' ? { username: m.username, password: m.password } : {}),
          }
        : {}),
      ...(m.protocol === 'socketio' ? { transports: m.transports } : {}),
      ...(m.protocol === 'graphql-subscription'
        ? {
            query: m.query,
            variables: m.variables,
            connectionParams: m.connectionParams,
            graphqlProtocol: m.graphqlProtocol,
          }
        : {}),
      // Kafka headers belong to each record, not to the connection.
      headers: m.protocol === 'kafka' ? [] : this.headers().filter((h) => h.enabled && h.key),
    };
  }
  /** Saves this configuration as a request in a collection. */
  protected save() {
    void this.task.run(async () => {
      const m = this.model();
      const settings: RealtimeSettings = {
        ...m,
        protocol: m.protocol as RealtimeSettings['protocol'],
        headers: this.headers().filter((h) => h.key),
      };
      if (!this.state.active()) this.state.newTab();
      const tab = this.state.active()!;
      this.loadedTab = tab.id;
      this.state.edit({
        ...tab.request,
        name: tab.request.name === 'Untitled request' ? `${m.protocol} ${m.url}` : tab.request.name,
        protocol: settings.protocol,
        url: m.url,
        realtime: settings,
      });
      await this.state.saveActive();
    });
  }
  protected connect() {
    void this.task.run(async () => {
      // Only one connection per panel: close the previous one first.
      await this.close();
      const result = await this.protocols.connect(this.state.workspaceId(), this.options());
      this.connection.set(result.id);
      this.status.set(result.state);
      this.events.set([]);
      this.schedule(result.id);
    });
  }
  /** Polls one connection at a time; the next poll starts after the previous one finished. */
  private schedule(id: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(id), 350);
  }
  private async poll(id: string) {
    if (this.connection() !== id) return;
    try {
      const result = await this.protocols.poll(
        this.state.workspaceId(),
        id,
        this.events().at(-1)?.sequence ?? 0,
      );
      if (this.connection() !== id) return;
      this.status.set(result.state);
      this.events.update((e) => [...e, ...result.events].slice(-500));
      if (result.state === 'connecting' || result.state === 'connected') this.schedule(id);
    } catch {
      this.status.set('disconnected');
    }
  }
  private async close() {
    const id = this.connection();
    clearTimeout(this.timer);
    if (!id) return;
    this.connection.set('');
    await this.protocols.close(this.state.workspaceId(), id).catch(() => {});
  }
  protected disconnect() {
    void this.task.run(async () => {
      await this.close();
      this.status.set('disconnected');
    });
  }
  protected send(action = 'publish') {
    void this.task.run(async () => {
      const m = this.model();
      const partition = m.partition.trim();
      const offset = m.offset.trim();
      await this.protocols.send(this.state.workspaceId(), this.connection(), {
        action,
        message: m.message,
        topic: m.topic,
        event: m.event,
        qos: Number(m.qos),
        ...(m.protocol === 'kafka'
          ? {
              key: m.key,
              headers: this.headers().filter((h) => h.enabled && h.key),
              from: m.from as 'earliest' | 'latest' | 'offset',
              ...(partition ? { partition: Number(partition) } : {}),
              ...(m.from === 'offset' && offset ? { offset: Number(offset) } : {}),
            }
          : {}),
      });
    });
  }
  /** Lists the services and methods, and selects the first ones if none is chosen. */
  protected discover() {
    void this.task.run(async () => {
      const m = this.model();
      const key = this.discoveryKey();
      const found = await this.protocols.discoverGrpc(this.state.workspaceId(), {
        url: m.url,
        proto: m.proto,
        reflection: m.reflection,
        tls: m.tls,
        caPem: m.caPem,
        metadata: m.metadata,
      });
      this.discoveries.update((all) => ({ ...all, [key]: found }));
      const service = found.services.includes(m.service) ? m.service : (found.services[0] ?? '');
      const methods = found.methods[service] ?? [];
      const method = methods.some((item) => item.name === m.method)
        ? m.method
        : (methods[0]?.name ?? '');
      this.model.update((x) => ({ ...x, service, method }));
    });
  }
  protected chooseService(event: Event) {
    const service = (event.target as HTMLSelectElement).value;
    const method = this.discovery()?.methods[service]?.[0]?.name ?? '';
    this.model.update((m) => ({ ...m, service, method }));
  }
  protected invoke() {
    void this.task.run(async () => {
      const m = this.model();
      const result = await this.protocols.grpc(this.state.workspaceId(), {
        url: m.url,
        proto: m.proto,
        reflection: m.reflection,
        service: m.service,
        method: m.method,
        tls: m.tls,
        caPem: m.caPem,
        message: m.grpcMessage,
        metadata: m.metadata,
      });
      this.result.set(JSON.stringify(result, null, 2));
    });
  }
  protected json(value: unknown) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
}
