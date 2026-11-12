import { TranslocoPipe } from '@jsverse/transloco';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
  untracked,
  model,
  signal,
  output,
  input,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import {
  RequestDraft,
  KeyValue,
  editableBodyModes,
  newRequest,
  formatJson,
  pathVariableRows,
} from '../domain/models';
import { AuthDraft, Inheritance } from '../domain/auth';
import { ResolvedVariable } from '../domain/variables';
import { AppearanceState } from './appearance-state';
import { AuthEditor } from './auth-editor';
import { KeyValueEditor } from './key-value-editor';
import { StudioIcon } from './studio-icon';
import { WorkspaceState } from './workspace-state';
import { GraphqlExplorer } from './graphql-explorer';
import { GraphqlQueryEditor } from './graphql-query-editor';
import { CodeEditor } from './code-editor';
import { RequestSettings } from './request-settings';
import { VariableStrip } from './variable-strip';
import { bodyLanguage } from './code-language';
import { insertAt } from '../domain/graphql-schema';

@Component({
  imports: [
    TranslocoPipe,
    FormField,
    KeyValueEditor,
    StudioIcon,
    AuthEditor,
    GraphqlExplorer,
    GraphqlQueryEditor,
    CodeEditor,
    RequestSettings,
    VariableStrip,
  ],
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
  /** Where "Inherit from parent" takes the authorization from. */
  readonly inheritance = input<Inheritance | undefined>(undefined);
  readonly editInheritedAuth = output<void>();
  /** OAuth 2.0 token request in progress. */
  readonly tokenBusy = input(false);
  /** OAuth 2.0 "Get new access token" (`false`) or "Refresh" (`true`). */
  readonly oauth2Token = output<boolean>();
  readonly manageVariables = output<void>();
  readonly send = output<void>();
  readonly cancelRequest = output<void>();
  readonly save = output<void>();
  readonly code = output<void>();
  readonly cookies = output<void>();
  protected readonly fields = form(this.request, (p) => {
    min(p.timeout, 100);
    max(p.timeout, 120000);
  });
  protected readonly tab = signal('params');
  protected readonly scriptTab = signal('tests');
  protected readonly tabs = ['params', 'authorization', 'headers', 'body', 'scripts', 'settings'];
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly appearance = inject(AppearanceState);
  protected readonly state = inject(WorkspaceState);
  private readonly query = viewChild<GraphqlQueryEditor>('query');
  /** The schema loaded for this request's endpoint, if any. */
  protected readonly schema = computed(() => this.state.schemaFor(this.request().url));
  /** The colours of the raw body follow the type chosen next to it. */
  protected readonly rawLanguage = computed(() => bodyLanguage(this.request().bodyLanguage));
  /** The body type shown: GraphQL is a protocol of the request, as Postman lists it. */
  protected readonly bodyType = computed(() =>
    this.request().protocol === 'graphql' ? 'graphql' : this.request().bodyMode,
  );
  private readonly requestId = computed(() => this.request().id);
  private readonly pathVariableCount = computed(() => this.pathVariables().length);

  constructor() {
    // Opening a request (or adding a `:name` to its URL) shows all its parameters: a panel
    // made smaller grows to fit them, up to 60% of the space. The size is not kept, and the
    // divider still moves it.
    afterRenderEffect(() => {
      this.requestId();
      this.pathVariableCount();
      if (this.tab() !== 'params' || this.appearance.current() === 'canvas') return;
      const content = this.host.querySelector<HTMLElement>('.request-content');
      const main = this.host.closest('.main-workspace');
      if (!content || !main) return;
      const hidden = content.scrollHeight - content.clientHeight;
      if (hidden <= 1) return;
      const room =
        (main.getBoundingClientRect().bottom - content.getBoundingClientRect().top) * 0.6;
      const size = Math.min(content.offsetHeight + hidden, Math.max(content.offsetHeight, room));
      if (size > content.offsetHeight + 1) untracked(() => this.appearance.resize('request', size));
    });
  }
  /** One row per `:name` segment of the URL, with the value entered for it. */
  protected readonly pathVariables = computed(() =>
    pathVariableRows(this.request().url, this.request().pathVariables ?? []),
  );
  /** An imported body type the editor does not handle (a binary file), kept on save. */
  protected readonly keptBodyMode = computed(
    () =>
      this.request().protocol !== 'graphql' && !editableBodyModes.includes(this.request().bodyMode),
  );
  protected editPathVariables(rows: KeyValue[]) {
    this.request.update((r) => ({
      ...r,
      // Values of names no longer in the URL are kept, as Postman does while editing.
      pathVariables: [
        ...rows,
        ...(r.pathVariables ?? []).filter((x) => !rows.some((row) => row.key === x.key)),
      ],
    }));
  }
  protected rows(key: 'query' | 'headers' | 'form', rows: KeyValue[]) {
    this.request.update((r) => ({ ...r, [key]: rows }));
  }
  protected editAuth(auth: AuthDraft) {
    this.request.update((r) => ({ ...r, auth }));
  }
  /** The file of a binary body: sent with the request, while the collection keeps its name. */
  protected async chooseBody(event: Event) {
    const target = event.target as HTMLInputElement;
    const chosen = target.files?.[0];
    target.value = '';
    if (!chosen) return;
    try {
      const file = await this.state.cases.attachFile(chosen);
      this.request.update((r) => ({ ...r, bodyFile: { src: file.name, file } }));
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  protected setBodyType(event: Event) {
    const type = (event.target as HTMLSelectElement).value;
    this.request.update((r) =>
      type === 'graphql'
        ? { ...r, protocol: 'graphql', bodyMode: 'raw' }
        : { ...r, protocol: r.protocol === 'graphql' ? 'http' : r.protocol, bodyMode: type },
    );
  }
  /** Inserts a field from the schema explorer at the cursor of the query. */
  protected insertField(snippet: string) {
    const editor = this.query();
    if (editor) return editor.insert(snippet);
    const body = this.request().body;
    this.request.update((r) => ({ ...r, body: insertAt(body, body.length, snippet).value }));
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
