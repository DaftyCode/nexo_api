import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  input,
  DestroyRef,
} from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, row } from '../domain/models';

@Component({
  imports: [FormField, KeyValueEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-integration-panel',
  styleUrl: './integration-panel.scss',
  templateUrl: './integration-panel.html',
})
export class IntegrationPanel {
  readonly section = input('settings');
  protected readonly state = inject(WorkspaceState);
  private readonly destroy = inject(DestroyRef);
  protected readonly tab = signal('general');
  protected readonly output = signal('');
  protected readonly model = signal({
    branch: '',
    message: 'Update API collections',
    url: 'http://localhost:3000/mcp',
    method: 'tools/list',
    params: '{}',
    language: 'curl',
    variant: 'cURL',
    secretName: 'api_token',
    secretValue: '',
    email: '',
    role: 'editor',
    documentId: '',
    apiName: 'My API',
    apiSpec: 'openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    grant: 'client_credentials',
    code: '',
    redirectUri: '',
    verifier: '',
    scope: '',
    users: 1,
    duration: 10,
    profile: 'fixed',
  });
  protected readonly fields = form(this.model, (p) => {
    min(p.users, 1);
    max(p.users, 4);
    min(p.duration, 1);
    max(p.duration, 120);
  });
  protected readonly headers = signal<KeyValue[]>([row()]);
  protected readonly revisions = signal<
    {
      revision: number;
      changed_at: number;
      actor_id: string;
      value: import('../domain/models').WorkspaceDocument;
    }[]
  >([]);
  private timer: ReturnType<typeof setInterval> | undefined;
  private performanceId = '';
  constructor() {
    this.destroy.onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
    });
  }
  protected git(operation: string) {
    void this.state.guard(async () => {
      if (operation === 'export') {
        await this.state.cases.api.git('export', {
          workspace: this.state.workspaceId(),
          files: this.state.collections().map((d) => ({ id: d.id, value: d.value })),
        });
        this.output.set('Collections exported to the workspace project directory.');
        return;
      }
      const result = await this.state.cases.api.git(operation, {
        workspace: this.state.workspaceId(),
        branch: this.model().branch,
        message: this.model().message,
      });
      this.output.set(JSON.stringify(result, null, 2));
    });
  }
  protected mcp() {
    void this.state.guard(async () => {
      const m = this.model();
      const result = await this.state.cases.api.execute('mcp.request', {
        url: m.url,
        method: m.method,
        params: JSON.parse(m.params),
        headers: Object.fromEntries(
          this.headers()
            .filter((h) => h.key && h.enabled)
            .map((h) => [h.key, h.value]),
        ),
      });
      this.output.set(JSON.stringify(result, null, 2));
    });
  }
  protected code() {
    void this.state.guard(async () => {
      const request = this.state.active()?.request;
      if (!request) throw new Error('Open a request first');
      const result = await this.state.cases.api.execute<{ code: string }>('codegen', {
        request,
        language: this.model().language,
        variant: this.model().variant,
      });
      this.output.set(result.code);
    });
  }
  protected secret(remove = false) {
    void this.state.guard(async () => {
      if (remove) await this.state.cases.api.removeSecret(this.model().secretName);
      else await this.state.cases.api.putSecret(this.model().secretName, this.model().secretValue);
      this.model.update((m) => ({ ...m, secretValue: '' }));
      this.output.set(remove ? 'Secret removed.' : 'Secret encrypted and saved.');
    });
  }
  protected invite() {
    void this.state.guard(async () => {
      await this.state.cases.api.addMember(
        this.state.workspaceId(),
        this.model().email,
        this.model().role,
      );
      await this.members();
    });
  }
  protected async members() {
    this.output.set(
      JSON.stringify(await this.state.cases.api.members(this.state.workspaceId()), null, 2),
    );
  }
  protected revisionList() {
    void this.state.guard(async () =>
      this.revisions.set(await this.state.cases.api.revisions(this.model().documentId)),
    );
  }
  protected restore(value: import('../domain/models').WorkspaceDocument) {
    void this.state.guard(async () => {
      const current = this.state.documents().find((d) => d.id === value.id);
      if (!current) throw new Error('Document no longer exists');
      await this.state.cases.api.save({ ...value, revision: current.revision });
      await this.state.refresh();
      this.output.set('Revision restored as a new revision.');
    });
  }
  protected apiSpec() {
    void this.state.guard(async () => {
      await this.state.cases.createDocument(this.state.workspaceId(), 'api', this.model().apiName, {
        source: this.model().apiSpec,
      });
      await this.state.refresh();
      this.output.set('API specification saved.');
    });
  }
  protected importApi() {
    void this.state.importContent(this.model().apiSpec);
  }
  protected oauth() {
    void this.state.guard(async () => {
      const m = this.model();
      const fields: Record<string, string> = {
        grant_type: m.grant,
        client_id: m.clientId,
        client_secret: m.clientSecret,
        scope: m.scope,
      };
      if (m.code) fields[m.grant === 'refresh_token' ? 'refresh_token' : 'code'] = m.code;
      if (m.redirectUri) fields['redirect_uri'] = m.redirectUri;
      if (m.verifier) fields['code_verifier'] = m.verifier;
      const result = await this.state.cases.api.execute<{ body: Record<string, unknown> }>(
        'oauth.token',
        { url: m.tokenUrl, fields },
      );
      this.output.set(JSON.stringify(result, null, 2));
      const token = result.body?.['access_token'];
      const active = this.state.active();
      if (typeof token === 'string' && active)
        this.state.edit({
          ...active.request,
          auth: { ...active.request.auth, type: 'bearer', token },
        });
    });
  }
  protected performance() {
    void this.state.guard(async () => {
      const request = this.state.active()?.request;
      if (!request) throw new Error('Open a request first');
      const result = await this.state.cases.api.execute<{ id: string }>('performance', {
        ...this.model(),
        request,
        variables: this.state.variables(),
      });
      this.performanceId = result.id;
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.pollPerformance(), 500);
    });
  }
  private async pollPerformance() {
    try {
      const result = await this.state.cases.api.execute<{ state: string }>('performance', {
        id: this.performanceId,
        action: 'status',
      });
      this.output.set(JSON.stringify(result, null, 2));
      if (result.state !== 'running') clearInterval(this.timer);
    } catch {
      clearInterval(this.timer);
    }
  }
  protected stopPerformance() {
    void this.state.guard(async () => {
      await this.state.cases.api.execute('performance.cancel', { id: this.performanceId });
      clearInterval(this.timer);
    });
  }
}
