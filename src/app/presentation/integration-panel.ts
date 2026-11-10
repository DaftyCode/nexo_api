import { TranslocoPipe } from '@jsverse/transloco';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  input,
  DestroyRef,
  effect,
  untracked,
  computed,
} from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { PanelTask } from './panel-task';
import { GitRemotes } from './git-remotes';
import { McpCall, McpResults } from './mcp-results';
import { ApiDefinitions } from './api-definitions';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, WorkspaceDocument, row } from '../domain/models';
import { GitOperation } from '../application/operations';
import { toPortableRows } from '../domain/variables';
import { RevisionEntry } from '../application/ports';
import { PerformanceStatus } from '../application/integration-use-cases';
import { INTEGRATION } from '../composition/providers';
import {
  GitStatus,
  McpView,
  mcpView,
  parseGitStatus,
  tokenView,
} from '../domain/integration-views';
import { SecretSummary, formatAllowedDomains } from '../domain/secrets';
import { CodeEditor } from './code-editor';

/** The local Git operations of the panel; remotes have their own component. */
type PanelGitOperation = Extract<
  GitOperation,
  | 'init'
  | 'export'
  | 'status'
  | 'diff'
  | 'log'
  | 'branches'
  | 'stash'
  | 'branch'
  | 'checkout'
  | 'commit'
>;

/** Structured result shown above the raw output. */
type View =
  | { kind: 'git'; status: GitStatus }
  | { kind: 'mcp'; view: McpView }
  | { kind: 'token'; view: ReturnType<typeof tokenView> };

@Component({
  imports: [
    TranslocoPipe,
    FormField,
    KeyValueEditor,
    GitRemotes,
    McpResults,
    ApiDefinitions,
    CodeEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-integration-panel',
  styleUrl: './integration-panel.scss',
  templateUrl: './integration-panel.html',
})
export class IntegrationPanel {
  readonly section = input('settings');
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  private readonly integration = inject(INTEGRATION);
  protected readonly view = signal<View | undefined>(undefined);
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
    secretDomains: '',
    documentId: '',
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
    workspaceName: '',
  });
  protected readonly fields = form(this.model, (p) => {
    min(p.users, 1);
    max(p.users, 4);
    min(p.duration, 1);
    max(p.duration, 120);
  });
  protected readonly headers = signal<KeyValue[]>([row()]);
  protected readonly revisions = signal<RevisionEntry[]>([]);
  protected readonly secrets = signal<SecretSummary[]>([]);
  private readonly secretName = computed(() => this.model().secretName);
  protected readonly formatDomains = formatAllowedDomains;
  protected readonly performanceStatus = signal<PerformanceStatus | undefined>(undefined);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private performanceId = '';
  constructor() {
    this.destroy.onDestroy(() => clearTimeout(this.timer));
    // Typing a saved secret's name shows its allowed domains, so saving a new value keeps them.
    // It reacts to the name only, never to the domains being edited.
    effect(() => {
      const name = this.secretName();
      const saved = this.secrets().find((secret) => secret.name === name);
      if (!saved) return;
      const domains = formatAllowedDomains(saved.allowedHosts);
      untracked(() => {
        if (this.model().secretDomains !== domains)
          this.model.update((m) => ({ ...m, secretDomains: domains }));
      });
    });
    effect(() => {
      const name = this.state.workspaces().find((w) => w.id === this.state.workspaceId())?.name;
      untracked(() => this.model.update((m) => ({ ...m, workspaceName: name ?? '' })));
    });
    effect(() => {
      const section = this.section();
      const tab = this.tab();
      untracked(() => {
        if (section !== 'git' && section !== 'mcp' && tab === 'vault') void this.loadSecrets();
      });
    });
  }
  protected readonly gitActions: readonly PanelGitOperation[] = [
    'init',
    'export',
    'status',
    'diff',
    'log',
    'branches',
    'stash',
  ];
  /** The output of a remote operation, and the status it leaves. */
  protected gitResult(text: string) {
    this.output.set(text);
    void this.refreshStatus();
  }
  private async refreshStatus() {
    try {
      const result = await this.integration.git(this.state.workspaceId(), 'status');
      if (result.success) this.view.set({ kind: 'git', status: parseGitStatus(result.stdout) });
    } catch {
      // A project without a repository has no status to show.
    }
  }
  protected git(operation: PanelGitOperation) {
    this.view.set(undefined);
    void this.task.run(async () => {
      const workspace = this.state.workspaceId();
      if (operation === 'export') {
        await this.integration.exportCollections(workspace, this.state.collections());
        this.output.set(
          'Collections exported to the workspace project directory without literal credentials.',
        );
        return;
      }
      const result = await this.integration.git(workspace, operation, {
        branch: this.model().branch,
        message: this.model().message,
      });
      if (operation === 'status' && result.success)
        this.view.set({ kind: 'git', status: parseGitStatus(result.stdout) });
      this.output.set(
        [result.stdout, result.stderr].filter(Boolean).join('\n').trim() ||
          (result.success ? 'Done.' : 'Git reported an error.'),
      );
    });
  }
  private parseJson(text: string, label: string) {
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new Error(`${label} must be valid JSON`);
    }
  }
  /** The MCP session `initialize` opened, kept for the server that gave it. */
  private mcpSession = { url: '', id: '' };
  protected mcp() {
    void this.task.run(async () => {
      const m = this.model();
      const session = this.mcpSession.url === m.url ? this.mcpSession.id : '';
      const result = await this.integration.mcp(this.state.workspaceId(), {
        url: m.url,
        method: m.method,
        params: this.parseJson(m.params, 'Parameters'),
        headers: Object.fromEntries(
          this.headers()
            .filter((h) => h.key && h.enabled)
            .map((h) => [h.key, h.value]),
        ),
        ...(session ? { sessionId: session } : {}),
      });
      const view = mcpView(result);
      if (view.session) this.mcpSession = { url: m.url, id: view.session };
      this.view.set({ kind: 'mcp', view });
      this.output.set(JSON.stringify(result, null, 2));
    });
  }
  /** A call chosen from the results: written in the form, and sent when asked. */
  protected mcpCall(call: McpCall) {
    this.model.update((m) => ({
      ...m,
      method: call.method,
      params: JSON.stringify(call.params, null, 2),
    }));
    if (call.send) this.mcp();
  }
  protected code() {
    void this.task.run(async () => {
      const request = this.state.active()?.request;
      if (!request) throw new Error('Open a request first');
      this.output.set(
        await this.integration.generateCode(
          this.state.workspaceId(),
          request,
          this.model().language,
          this.model().variant,
        ),
      );
    });
  }
  protected async loadSecrets() {
    try {
      this.secrets.set(await this.integration.secrets());
    } catch {
      this.secrets.set([]);
    }
  }
  /** Loads a saved secret into the form to change its value or allowed domains. */
  protected editSecret(secret: SecretSummary) {
    this.model.update((m) => ({
      ...m,
      secretName: secret.name,
      secretValue: '',
      secretDomains: formatAllowedDomains(secret.allowedHosts),
    }));
  }
  protected secret(remove = false, name = this.model().secretName) {
    void this.task.run(async () => {
      if (remove) await this.integration.removeSecret(name);
      else
        await this.integration.saveSecret(
          name,
          this.model().secretValue,
          this.model().secretDomains,
          this.secrets().some((secret) => secret.name === name),
        );
      this.model.update((m) => ({ ...m, secretValue: '' }));
      this.output.set(
        remove
          ? 'Secret removed.'
          : `Secret encrypted and saved. Reference it with {{vault:${name}}}.`,
      );
      await this.loadSecrets();
    });
  }
  protected renameWorkspace() {
    void this.state.renameWorkspace(this.model().workspaceName);
  }
  protected revisionList() {
    void this.task.run(async () => {
      this.revisions.set(await this.integration.revisions(this.model().documentId));
    });
  }
  protected restore(value: WorkspaceDocument) {
    void this.task.run(async () => {
      const current = this.state.documents().find((d) => d.id === value.id);
      await this.integration.restoreRevision(value, current);
      await this.state.refresh();
      this.output.set('Revision restored as a new revision.');
    });
  }
  protected oauth() {
    void this.task.run(async () => {
      const m = this.model();
      const result = await this.integration.exchangeToken(this.state.workspaceId(), {
        url: m.tokenUrl,
        grant: m.grant,
        clientId: m.clientId,
        clientSecret: m.clientSecret,
        scope: m.scope,
        code: m.code,
        redirectUri: m.redirectUri,
        verifier: m.verifier,
      });
      this.view.set({ kind: 'token', view: tokenView(result) });
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
    void this.task.run(async () => {
      const request = this.state.active()?.request;
      if (!request) throw new Error('Open a request first');
      const m = this.model();
      const result = await this.integration.startLoadTest(this.state.workspaceId(), {
        users: m.users,
        duration: m.duration,
        profile: m.profile,
        request,
        variables: this.state.variables(),
        globals: toPortableRows(this.state.globalRows()),
        ancestors: this.state.activeAncestors(),
      });
      this.performanceId = result.id;
      this.performanceStatus.set({ state: 'running' });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.pollPerformance(), 500);
    });
  }
  private async pollPerformance() {
    try {
      const result = await this.integration.loadTestStatus(
        this.state.workspaceId(),
        this.performanceId,
      );
      this.performanceStatus.set(result);
      this.output.set(JSON.stringify(result.summary ?? result, null, 2));
      if (result.state === 'running')
        this.timer = setTimeout(() => void this.pollPerformance(), 500);
    } catch (error) {
      this.output.set(error instanceof Error ? error.message : String(error));
    }
  }
  protected stopPerformance() {
    void this.task.run(async () => {
      if (!this.performanceId) return;
      await this.integration.cancelLoadTest(this.state.workspaceId(), this.performanceId);
    });
  }
}
