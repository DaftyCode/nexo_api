import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model, signal, output, input } from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';
import { RequestDraft, KeyValue, newRequest, formatJson } from '../domain/models';
import { ResolvedVariable } from '../domain/variables';
import { KeyValueEditor } from './key-value-editor';
import { StudioIcon } from './studio-icon';

@Component({
  imports: [TranslocoPipe, FormField, KeyValueEditor, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-request-editor',
  styleUrl: './request-editor.scss',
  templateUrl: './request-editor.html',
})
export class RequestEditor {
  readonly request = model<RequestDraft>(newRequest('untitled'));
  readonly running = input(false);
  readonly readonly = input(false);
  /** Variables referenced by the request and the scope that resolves each one. */
  readonly variables = input<ResolvedVariable[]>([]);
  readonly manageVariables = output<void>();
  readonly send = output<void>();
  readonly cancelRequest = output<void>();
  readonly save = output<void>();
  readonly code = output<void>();
  protected readonly fields = form(this.request, (p) => {
    min(p.timeout, 100);
    max(p.timeout, 120000);
  });
  protected readonly tab = signal('params');
  protected readonly scriptTab = signal('tests');
  protected readonly tabs = ['params', 'authorization', 'headers', 'body', 'scripts', 'settings'];
  protected rows(key: 'query' | 'headers' | 'form', rows: KeyValue[]) {
    this.request.update((r) => ({ ...r, [key]: rows }));
  }
  protected variableTitle(variable: ResolvedVariable) {
    if (!variable.defined) return 'Not defined in the active environment, collection or globals';
    if (variable.scope === 'dynamic') return 'Generated for each request';
    if (variable.scope === 'vault') return 'Resolved from your vault when sent';
    return variable.secret ? '••••••••' : (variable.value ?? '');
  }
  protected format() {
    this.request.update((r) => ({ ...r, body: formatJson(r.body) }));
  }
  protected addTest() {
    this.request.update((r) => ({
      ...r,
      tests:
        r.tests +
        '\nnx.test("Response is successful", () => {\n  nx.expect(nx.response.code).to.be.within(200, 299);\n});',
    }));
  }
}
