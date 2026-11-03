import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';
import { WORKSPACE } from '../composition/providers';
import {
  CollectionItem,
  ExecutionResponse,
  Health,
  KeyValue,
  RequestDraft,
  RequestTab,
  Run,
  Workspace,
  WorkspaceDocument,
  asCollection,
  fromItem,
  items,
  newRequest,
  toItem,
} from '../domain/models';
@Injectable({ providedIn: 'root' })
export class WorkspaceState {
  readonly cases = inject(WORKSPACE);
  private readonly destroy = inject(DestroyRef);
  readonly ready = signal(false);
  readonly health = signal<Health | undefined>(undefined);
  readonly authenticated = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly running = signal(false);
  readonly workspaces = signal<Workspace[]>([]);
  readonly workspaceId = signal('');
  readonly documents = signal<WorkspaceDocument[]>([]);
  readonly section = signal('collections');
  readonly filter = signal('');
  readonly environmentId = signal('');
  readonly tabs = signal<RequestTab[]>([]);
  readonly activeTabId = signal('');
  readonly response = signal<ExecutionResponse | undefined>(undefined);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeTabId()));
  readonly collections = computed(() => this.documents().filter((d) => d.kind === 'collection'));
  readonly environments = computed(() => this.documents().filter((d) => d.kind === 'environment'));
  readonly history = computed(() => this.documents().filter((d) => d.kind === 'history'));
  readonly variables = computed(() => {
    const d = this.environments().find((d) => d.id === this.environmentId());
    return (d?.value as { values?: KeyValue[] } | undefined)?.values ?? [];
  });
  readonly writable = computed(
    () => this.workspaces().find((w) => w.id === this.workspaceId())?.role !== 'viewer',
  );
  readonly run = signal<Run | undefined>(undefined);
  readonly consoleOpen = signal(false);
  private requestExecution = '';
  private runTimer: ReturnType<typeof setInterval> | undefined;
  constructor() {
    this.destroy.onDestroy(() => {
      if (this.runTimer) clearInterval(this.runTimer);
    });
  }
  async initialize() {
    await this.guard(async () => {
      await this.cases.api.initialize();
      this.health.set(await this.cases.api.health());
      try {
        await this.loadWorkspaces();
        this.authenticated.set(true);
      } catch {
        this.authenticated.set(false);
      }
      this.ready.set(true);
    });
  }
  async authenticate(
    mode: 'login' | 'register',
    credentials: { name: string; email: string; password: string },
  ) {
    await this.guard(async () => {
      await this.cases.api.authenticate(mode, credentials);
      await this.loadWorkspaces();
      this.authenticated.set(true);
      this.health.update((h) => (h ? { ...h, setupRequired: false } : h));
    });
  }
  async signOut() {
    await this.guard(async () => {
      await this.cases.api.signOut();
      this.authenticated.set(false);
      this.documents.set([]);
      this.tabs.set([]);
    });
  }
  private async loadWorkspaces() {
    this.workspaces.set(await this.cases.api.workspaces());
    if (!this.workspaces().some((w) => w.id === this.workspaceId()))
      this.workspaceId.set(this.workspaces()[0]?.id ?? '');
    await this.refresh();
    if (!this.tabs().length) this.newTab();
  }
  async selectWorkspace(id: string) {
    this.workspaceId.set(id);
    this.tabs.set([]);
    this.environmentId.set('');
    this.response.set(undefined);
    await this.guard(() => this.refresh());
    this.newTab();
  }
  async refresh() {
    this.documents.set(await this.cases.api.documents(this.workspaceId()));
  }
  newTab(request?: RequestDraft, documentId = '', path: number[] = []) {
    const id = this.cases.files.id();
    this.tabs.update((t) => [
      ...t,
      { id, request: request ?? newRequest(id), documentId, path, dirty: false },
    ]);
    this.activeTabId.set(id);
    this.response.set(undefined);
    this.section.set('collections');
  }
  closeTab(id: string) {
    this.tabs.update((t) => t.filter((x) => x.id !== id));
    if (this.activeTabId() === id) this.activeTabId.set(this.tabs().at(-1)?.id ?? '');
    if (!this.tabs().length) this.newTab();
  }
  edit(request: RequestDraft) {
    const id = this.activeTabId();
    this.tabs.update((t) =>
      t.map((tab) => (tab.id === id ? { ...tab, request, dirty: true } : tab)),
    );
  }
  openItem(document: WorkspaceDocument, item: CollectionItem, path: number[]) {
    if (item.item) return;
    const open = this.tabs().find(
      (t) => t.documentId === document.id && JSON.stringify(t.path) === JSON.stringify(path),
    );
    if (open) {
      this.activeTabId.set(open.id);
      this.section.set('collections');
      return;
    }
    this.newTab(fromItem(item, this.cases.files.id()), document.id, path);
  }
  collectionItems(document: WorkspaceDocument) {
    try {
      return items(asCollection(document.value)).filter(
        (x) => !this.filter() || x.item.name.toLowerCase().includes(this.filter().toLowerCase()),
      );
    } catch {
      return [];
    }
  }
  async createCollection(name: string) {
    await this.guard(async () => {
      const d = await this.cases.createCollection(this.workspaceId(), name);
      this.documents.update((docs) => [...docs, d]);
      this.notice.set('Collection created');
    });
  }
  async addRequest(document: WorkspaceDocument, folderPath: number[] = []) {
    const value = structuredClone(asCollection(document.value));
    let target = value.item;
    for (const index of folderPath) target = target[index].item ??= [];
    const draft = newRequest(this.cases.files.id());
    draft.name = 'New request';
    const index = target.push(toItem(draft)) - 1;
    await this.guard(async () => {
      const saved = await this.cases.api.save({ ...document, value });
      await this.refresh();
      this.newTab(draft, saved.id, [...folderPath, index]);
    });
  }
  async addFolder(document: WorkspaceDocument, name: string) {
    await this.guard(async () => {
      const value = structuredClone(asCollection(document.value));
      value.item.push({ name, item: [] });
      await this.cases.api.save({ ...document, value });
      await this.refresh();
    });
  }
  async saveActive(targetDocumentId?: string) {
    const tab = this.active();
    if (!tab) return;
    await this.guard(async () => {
      let document = this.collections().find((d) => d.id === (targetDocumentId ?? tab.documentId));
      if (!document)
        document = await this.cases.createCollection(this.workspaceId(), 'My collection');
      const path =
        tab.documentId === document.id && tab.path.length
          ? tab.path
          : [asCollection(document.value).item.length];
      const saved = await this.cases.saveRequest(document, path, tab.request);
      await this.refresh();
      this.tabs.update((t) =>
        t.map((x) => (x.id === tab.id ? { ...x, documentId: saved.id, path, dirty: false } : x)),
      );
      this.notice.set('Request saved');
    });
  }
  async send() {
    const tab = this.active();
    if (!tab || this.running()) return;
    this.running.set(true);
    this.error.set('');
    this.requestExecution = this.cases.files.id();
    try {
      if (['websocket', 'socketio', 'mqtt', 'grpc'].includes(tab.request.protocol)) {
        this.section.set('realtime');
        return;
      }
      const response = await this.cases.send(tab.request, this.variables(), this.requestExecution);
      this.response.set(response);
      await this.cases.createDocument(
        this.workspaceId(),
        'history',
        `${tab.request.method} ${tab.request.url}`,
        { request: tab.request, response },
      );
      await this.refresh();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.running.set(false);
    }
  }
  async cancel() {
    if (this.requestExecution)
      await this.guard(async () => {
        await this.cases.api.execute('cancel', { id: this.requestExecution });
        this.running.set(false);
      });
  }
  openHistory(document: WorkspaceDocument) {
    const v = document.value as { request: RequestDraft; response: ExecutionResponse };
    this.newTab(v.request);
    this.response.set(v.response);
  }
  async importContent(content: string) {
    await this.guard(async () => {
      await this.cases.import(this.workspaceId(), content);
      await this.refresh();
      this.notice.set('Import completed');
    });
  }
  export(document: WorkspaceDocument) {
    this.cases.export(document);
  }
  async remove(document: WorkspaceDocument) {
    await this.guard(async () => {
      await this.cases.api.remove(document);
      await this.refresh();
      this.notice.set('Deleted');
    });
  }
  async saveEnvironment(id: string, name: string, values: KeyValue[]) {
    await this.guard(async () => {
      const existing = this.environments().find((d) => d.id === id);
      const d = existing
        ? await this.cases.api.save({
            ...existing,
            name,
            value: { ...(existing.value as Record<string, unknown>), name, values },
          })
        : await this.cases.createDocument(this.workspaceId(), 'environment', name, {
            name,
            values,
          });
      await this.refresh();
      this.environmentId.set(d.id);
      this.notice.set('Environment saved');
    });
  }
  async startRun(collectionId: string, iterations: number, data: unknown[]) {
    await this.guard(async () => {
      const d = this.collections().find((d) => d.id === collectionId);
      if (!d) throw new Error('Choose a collection');
      const r = await this.cases.api.execute<{ id: string; state: string }>('run', {
        collection: d.value,
        variables: this.variables(),
        iterations,
        data,
      });
      this.run.set({ ...r, results: [], assertions: [], logs: [] });
      if (this.runTimer) clearInterval(this.runTimer);
      this.runTimer = setInterval(() => void this.pollRun(), 400);
    });
  }
  private async pollRun() {
    const run = this.run();
    if (!run) return;
    try {
      const r = await this.cases.api.execute<Run>('run', { action: 'status', id: run.id });
      this.run.set(r);
      if (r.state !== 'running') {
        clearInterval(this.runTimer);
        this.runTimer = undefined;
        await this.cases.createDocument(
          this.workspaceId(),
          'run',
          `Collection run ${new Date().toLocaleString()}`,
          r,
        );
        await this.refresh();
      }
    } catch (error) {
      clearInterval(this.runTimer);
      this.error.set(this.message(error));
    }
  }
  async cancelRun() {
    const r = this.run();
    if (r)
      await this.guard(async () => {
        this.run.set(await this.cases.api.execute<Run>('cancel', { id: r.id }));
      });
  }
  async guard(action: () => Promise<unknown>) {
    this.error.set('');
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
