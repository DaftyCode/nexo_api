import { Component, ChangeDetectionStrategy, inject, signal, input } from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';

@Component({
  imports: [FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-data-panel',
  styleUrl: './data-panel.scss',
  templateUrl: './data-panel.html',
})
export class DataPanel {
  readonly section = input('datasets');
  protected readonly state = inject(WorkspaceState);
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
  protected import() {
    void this.state.guard(async () => {
      const m = this.model();
      const result = await this.state.cases.api.execute<{
        id: string;
        rows: number;
        columns: string[];
      }>('dataset.import', { id: m.id || undefined, content: m.content });
      const existing = this.state
        .documents()
        .find((d) => d.kind === 'dataset' && d.id === result.id);
      if (existing) await this.state.cases.api.save({ ...existing, name: m.name, value: result });
      else
        await this.state.cases.api.save({
          id: result.id,
          workspace_id: this.state.workspaceId(),
          kind: 'dataset',
          name: m.name,
          revision: 0,
          updated_at: 0,
          value: result,
        });
      this.model.update((x) => ({ ...x, id: result.id }));
      this.output.set(`Imported ${result.rows} rows`);
      await this.state.refresh();
    });
  }
  protected query() {
    void this.state.guard(async () => {
      const m = this.model();
      if (!m.id) throw new Error('Import or choose a dataset first');
      const result = await this.state.cases.api.execute<{
        columns: string[];
        rows: Record<string, unknown>[];
        truncated: boolean;
      }>('dataset.query', { id: m.id, sql: m.sql });
      this.table.set(result);
      this.output.set(`${result.rows.length} rows${result.truncated ? ' (limit reached)' : ''}`);
    });
  }
  protected selectDataset(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    const d = this.state.documents().find((d) => d.id === id);
    this.model.update((m) => ({ ...m, id, name: d?.name ?? m.name }));
  }
  protected startMock() {
    void this.state.guard(async () => {
      const m = this.model();
      const result = await this.state.cases.api.execute<{ id: string; url: string }>('mock.start', {
        port: m.port,
        examples: JSON.parse(m.examples),
      });
      this.model.update((x) => ({ ...x, mockId: result.id }));
      this.mockUrl.set(result.url);
      await this.state.cases.createDocument(
        this.state.workspaceId(),
        'mock',
        `Mock ${new Date().toLocaleTimeString()}`,
        { ...result, examples: JSON.parse(m.examples) },
      );
      await this.state.refresh();
      await this.listMocks();
    });
  }
  protected async listMocks() {
    this.mocks.set(await this.state.cases.api.execute('mock.list', {}));
  }
  protected stop(id: string) {
    void this.state.guard(async () => {
      await this.state.cases.api.execute('mock.stop', { id });
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
