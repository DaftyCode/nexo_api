import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, inject, signal, DestroyRef } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';

@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-protocol-panel',
  styleUrl: './protocol-panel.scss',
  templateUrl: './protocol-panel.html',
})
export class ProtocolPanel {
  protected readonly state = inject(WorkspaceState);
  private readonly destroy = inject(DestroyRef);
  protected readonly model = signal({
    protocol: 'websocket',
    url: 'ws://localhost:9001',
    message: 'Hello from Nexo',
    topic: 'nexo/demo',
    event: 'message',
    proto:
      'syntax = "proto3";\npackage demo;\nservice Greeter { rpc Hello (HelloRequest) returns (HelloReply); }\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }',
    service: 'demo.Greeter',
    method: 'Hello',
    metadata: '[]',
    tls: false,
    qos: '0',
  });
  protected readonly fields = form(this.model);
  protected readonly connection = signal('');
  protected readonly status = signal('disconnected');
  protected readonly events = signal<
    { sequence: number; type: string; data: unknown; time: number }[]
  >([]);
  protected readonly result = signal('');
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor() {
    this.destroy.onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
      if (this.connection())
        void this.state.cases.api.execute('realtime.close', { id: this.connection() });
    });
  }
  protected connect() {
    void this.state.guard(async () => {
      const m = this.model();
      const result = await this.state.cases.api.execute<{ id: string; state: string }>(
        'realtime.connect',
        { ...m, qos: Number(m.qos) },
      );
      this.connection.set(result.id);
      this.status.set(result.state);
      this.events.set([]);
      this.timer = setInterval(() => void this.poll(), 350);
    });
  }
  private async poll() {
    try {
      const result = await this.state.cases.api.execute<{
        state: string;
        events: { sequence: number; type: string; data: unknown; time: number }[];
      }>('realtime.poll', { id: this.connection(), after: this.events().at(-1)?.sequence ?? 0 });
      this.status.set(result.state);
      this.events.update((e) => [...e, ...result.events].slice(-500));
    } catch {
      clearInterval(this.timer);
    }
  }
  protected disconnect() {
    void this.state.guard(async () => {
      await this.state.cases.api.execute('realtime.close', { id: this.connection() });
      this.connection.set('');
      this.status.set('disconnected');
      clearInterval(this.timer);
    });
  }
  protected send(action = 'publish') {
    void this.state.guard(async () => {
      await this.state.cases.api.execute('realtime.send', {
        ...this.model(),
        qos: Number(this.model().qos),
        id: this.connection(),
        action,
      });
    });
  }
  protected invoke() {
    void this.state.guard(async () => {
      const m = this.model();
      const result = await this.state.cases.api.execute('grpc', {
        ...m,
        message: JSON.parse(m.message),
        metadata: JSON.parse(m.metadata),
      });
      this.result.set(JSON.stringify(result, null, 2));
    });
  }
  protected json(value: unknown) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
}
