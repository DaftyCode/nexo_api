import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, computed, inject, signal, input } from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { PanelTask } from './panel-task';
import { DATA } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { CodeEditor } from './code-editor';

@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-data-panel',
  styleUrl: './data-panel.scss',
  templateUrl: './data-panel.html',
})
export class DataPanel {
  readonly section = input('datasets');
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  private readonly data = inject(DATA);
  protected readonly model = signal({
    id: '',
    name: 'My dataset',
    content: '[\n  {"name":"Ada", "requests":42},\n  {"name":"Linus", "requests":28}\n]',
    sql: 'SELECT * FROM data LIMIT 100',
    mockId: '',
    port: 0,
    examples:
      '[\n  {"method":"GET","path":"/hello","status":200,"body":{"message":"Hello from Nexo"}},\n  {"method":"POST","path":"/users","status":201,"body":{"id":1}}\n]',
  });
  protected readonly fields = form(this.model, (p) => {
    min(p.port, 0);
    max(p.port, 65535);
  });
  protected readonly output = signal('');
  protected readonly mockUrl = signal('');
  protected readonly mocks = signal<{ id: string; port: number; url: string }[]>([]);
  protected readonly table = signal<{ columns: string[]; rows: Record<string, unknown>[] }>({
    columns: [],
    rows: [],
  });
  constructor() {
    void this.listMocks();
  }
  private examples() {
    try {
      const value = JSON.parse(this.model().examples);
      if (!Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error('Mock examples must be a JSON array');
    }
  }
  protected import() {
    void this.task.run(async () => {
      const m = this.model();
      const result = await this.data.importDataset(
        this.state.workspaceId(),
        { id: m.id, name: m.name, content: m.content },
        this.state.documents(),
      );
      this.model.update((x) => ({ ...x, id: result.id }));
      this.output.set(`Imported ${result.rows} rows`);
      await this.state.refresh();
    });
  }
  protected query() {
    void this.task.run(async () => {
      const m = this.model();
      const result = await this.data.queryDataset(this.state.workspaceId(), m.id, m.sql);
      this.table.set(result);
      this.output.set(`${result.rows.length} rows${result.truncated ? ' (limit reached)' : ''}`);
    });
  }
  protected removeDataset() {
    void this.task.run(async () => {
      const m = this.model();
      const document = this.state.documents().find((d) => d.kind === 'dataset' && d.id === m.id);
      await this.data.deleteDataset(this.state.workspaceId(), m.id, document);
      await this.state.refresh();
      this.model.update((x) => ({ ...x, id: '' }));
      this.table.set({ columns: [], rows: [] });
      this.output.set('Dataset deleted');
    });
  }
  protected selectDataset(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    const d = this.state.documents().find((d) => d.id === id);
    this.model.update((m) => ({ ...m, id, name: d?.name ?? m.name }));
  }
  protected startMock() {
    void this.task.run(async () => {
      const m = this.model();
      const examples = this.examples();
      const result = await this.data.startMock(this.state.workspaceId(), m.port, examples);
      this.model.update((x) => ({ ...x, mockId: result.id }));
      this.mockUrl.set(result.url);
      await this.state.refresh();
      await this.listMocks();
    });
  }
  protected readonly savedMocks = computed(() =>
    this.state.documents().filter((document) => document.kind === 'mock'),
  );
  protected restartMock(document: WorkspaceDocument) {
    void this.task.run(async () => {
      const result = await this.data.restartMock(this.state.workspaceId(), document);
      this.mockUrl.set(result.url);
      await this.state.refresh();
      await this.listMocks();
    });
  }
  protected async listMocks() {
    try {
      this.mocks.set(await this.data.listMocks(this.state.workspaceId()));
    } catch {
      this.mocks.set([]);
    }
  }
  protected stop(id: string) {
    void this.task.run(async () => {
      await this.data.stopMock(this.state.workspaceId(), id);
      await this.listMocks();
      if (id === this.model().mockId) this.mockUrl.set('');
    });
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.model.update((m) => ({ ...m, content: '' }));
    if (file) {
      const content = await file.text();
      this.model.update((m) => ({ ...m, content, name: file.name.replace(/\.[^.]+$/, '') }));
    }
  }
  protected cell(value: unknown) {
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  }
}
