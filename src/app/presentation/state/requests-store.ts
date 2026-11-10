import { computed, signal } from '@angular/core';
import { historyRequest, historyResponse } from '../../domain/sanitize';
import { ExecutionResponse, RequestDraft, Run, WorkspaceDocument } from '../../domain/models';
import { CollectionsStore } from './collections-store';
import { DocumentsStore } from './documents-store';
import { StateContext } from './state-context';
import { VariablesStore } from './variables-store';

const realtimeProtocols = [
  'websocket',
  'socketio',
  'mqtt',
  'grpc',
  'graphql-subscription',
  'kafka',
];

/**
 * Sending requests, their history and saving collection run results. Each tab sends on its
 * own: while one waits, another can be sent, and its response goes to its tab.
 */
export class RequestsStore {
  /** The execution of each tab being sent, by tab. */
  private readonly executions = signal<Readonly<Record<string, string>>>({});
  /** Whether the active tab is being sent. */
  readonly running = computed(() => !!this.executions()[this.context.tabs.activeId()]);

  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
    private readonly variables: VariablesStore,
    private readonly collections: CollectionsStore,
  ) {}

  async send() {
    const { tabs, cases, status, section } = this.context;
    const tab = tabs.active();
    if (!tab || this.executions()[tab.id]) return;
    const execution = cases.files.id();
    this.executions.update((all) => ({ ...all, [tab.id]: execution }));
    status.error.set('');
    try {
      if (realtimeProtocols.includes(tab.request.protocol)) {
        section.set('realtime');
        return;
      }
      const environment = this.variables.environmentDocument();
      const collection = this.collections.activeCollection();
      const response = await cases.send(
        tab.request,
        {
          workspace: this.context.workspaceId(),
          environment: this.variables.environmentRows(),
          globals: this.variables.globalRows(),
          ancestors: this.collections.activeAncestors(),
        },
        execution,
      );
      // To the tab that sent it, even if another one is shown now.
      tabs.setResponse(tab.id, response);
      const saved = await this.variables.persist(response.variables, environment, collection);
      const history = await cases.createDocument(
        this.context.workspaceId(),
        'history',
        `${tab.request.method} ${tab.request.url}`,
        { request: historyRequest(tab.request), response: historyResponse(response) },
      );
      this.documents.applySaved([...saved, history]);
      void this.documents.pruneHistory();
    } catch (error) {
      status.error.set(status.describe(error));
    } finally {
      this.finish(tab.id);
    }
  }
  private finish(tab: string) {
    this.executions.update((all) => {
      const { [tab]: _done, ...others } = all;
      return others;
    });
  }
  /** Cancels the sending of the active tab. */
  async cancel() {
    const tab = this.context.tabs.activeId();
    const execution = this.executions()[tab];
    if (!execution) return;
    await this.context.cases.execute(this.context.workspaceId(), 'cancel', { id: execution });
    this.finish(tab);
  }
  /** Opens a history entry in a new tab with its response. */
  async openHistory(document: WorkspaceDocument) {
    const entry = await this.context.cases.loaded(document);
    const value = entry.value as { request: RequestDraft; response: ExecutionResponse };
    const tab = this.context.tabs.open(value.request);
    this.context.section.set('collections');
    this.context.tabs.setResponse(tab, value.response);
  }
  /** Saves the variables a finished run changed and keeps the run as a document. */
  async recordRun(run: Run, collectionId: string) {
    const saved = await this.variables.persist(
      { environment: run.environment, globals: run.globals, collection: run.collectionVariables },
      this.variables.environmentDocument(),
      this.documents.collections().find((d) => d.id === collectionId),
    );
    const document = await this.context.cases.createDocument(
      this.context.workspaceId(),
      'run',
      `Collection run ${new Date().toLocaleString()}`,
      run,
    );
    this.documents.applySaved([...saved, document]);
  }
}
