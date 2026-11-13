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
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState, named, success } from './workspace-state';
import { PanelTask } from './panel-task';
import { GitRemotes } from './git-remotes';
import { McpCall, McpResults } from './mcp-results';
import { ApiDefinitions } from './api-definitions';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, WorkspaceDocument, row } from '../domain/models';
import { GitOperation } from '../application/operations';
import { RevisionEntry } from '../application/ports';
import { INTEGRATION } from '../composition/providers';
import {
  GitStatus,
  McpView,
  mcpView,
  parseGitStatus,
  tokenView,
} from '../domain/integration-views';
import { CodeEditor } from './code-editor';
import { TokenExchange } from './token-exchange';
import { LoadTest, LoadTestRun } from './load-test';
import { VaultForm, VaultSecrets } from './vault-secrets';

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

/** The settings the panel starts with. */
const defaultModel = {
  branch: '',
  message: 'Update API collections',
  url: 'http://localhost:3000/mcp',
  method: 'tools/list',
  params: '{}',
  language: 'curl',
  variant: 'cURL',
  documentId: '',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  grant: 'client_credentials',
  code: '',
  redirectUri: '',
  verifier: '',
  scope: '',
  workspaceName: '',
};

export type IntegrationModel = typeof defaultModel;

import { SessionSettings } from './session-settings';
import { ModulesSettings } from './modules-settings';
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    KeyValueEditor,
    GitRemotes,
    McpResults,
    ApiDefinitions,
    CodeEditor,
    LoadTest,
    TokenExchange,
    VaultSecrets,
    SessionSettings,
    ModulesSettings,
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
  protected readonly model = signal<IntegrationModel>({ ...defaultModel });
  protected readonly fields = form(this.model);
  protected readonly headers = signal<KeyValue[]>([row()]);
  protected readonly revisions = signal<RevisionEntry[]>([]);
  protected readonly vault = new VaultForm(this.task, this.output);
  protected readonly loadTest = new LoadTestRun(this.task, this.output);
  constructor() {
    effect(() => {
      const name = this.state.workspaces().find((w) => w.id === this.state.workspaceId())?.name;
      untracked(() => this.model.update((m) => ({ ...m, workspaceName: name ?? '' })));
    });
    effect(() => {
      const section = this.section();
      const tab = this.tab();
      untracked(() => {
        if (section !== 'git' && section !== 'mcp' && tab === 'vault')
          void this.vault.loadSecrets();
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
    const workspace = this.state.workspaceId();
    if (operation === 'export') {
      void this.task.announce('The collections could not be exported', async () => {
        await this.integration.exportCollections(workspace, this.state.collections());
        this.output.set(
          'Collections exported to the workspace project directory without literal credentials.',
        );
        return success(
          'Collections exported',
          'To the project folder of the workspace, without literal credentials.',
        );
      });
      return;
    }
    const run = async () => {
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
      return result;
    };
    if (operation !== 'commit') {
      void this.task.run(run);
      return;
    }
    // A commit stores the changes in the repository: a toast says whether it did.
    void this.task.announce('The changes could not be committed', async () => {
      const result = await run();
      if (!result.success) throw new Error(result.stderr.trim() || 'Git reported an error.');
      return named('Changes committed', this.model().message);
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
  /** Downloads what the last action wrote in the output area. */
  protected saveOutput() {
    void this.state.download('nexo-output.txt', this.output(), 'text/plain');
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
    void this.task.announce('The revision could not be restored', async () => {
      const current = this.state.documents().find((d) => d.id === value.id);
      await this.integration.restoreRevision(value, current);
      await this.state.refresh();
      this.output.set('Revision restored as a new revision.');
      return success('Revision restored', 'toast.revisionRestored', { v0: value.name });
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
}
