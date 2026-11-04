import { TranslocoPipe } from '@jsverse/transloco';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  DestroyRef,
  effect,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { PanelTask } from './panel-task';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, RealtimeSettings, row } from '../domain/models';
import { StreamEvent } from '../application/protocol-use-cases';
import { PROTOCOLS } from '../composition/providers';

@Component({
  imports: [TranslocoPipe, FormField, KeyValueEditor],
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
  });
  protected readonly fields = form(this.model);
  protected readonly headers = signal<KeyValue[]>([row()]);
  protected readonly connection = signal('');
  protected readonly status = signal('disconnected');
  protected readonly events = signal<StreamEvent[]>([]);
  protected readonly result = signal('');
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
      headers: this.headers().filter((h) => h.enabled && h.key),
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
      await this.protocols.send(this.state.workspaceId(), this.connection(), {
        action,
        message: m.message,
        topic: m.topic,
        event: m.event,
        qos: Number(m.qos),
      });
    });
  }
  protected invoke() {
    void this.task.run(async () => {
      const m = this.model();
      const result = await this.protocols.grpc(this.state.workspaceId(), {
        url: m.url,
        proto: m.proto,
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
