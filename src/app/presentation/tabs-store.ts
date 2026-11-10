import { computed, signal } from '@angular/core';
import { ExecutionResponse, RequestDraft, RequestTab, newRequest } from '../domain/models';

/** Open request tabs, the active one, and the last response of each, as in Postman. */
export class TabsStore {
  readonly tabs = signal<RequestTab[]>([]);
  readonly activeId = signal('');
  /** The last response of each tab, by tab: switching tabs shows that tab's. */
  private readonly responses = signal<Readonly<Record<string, ExecutionResponse>>>({});
  /** The response of the active tab. */
  readonly response = computed<ExecutionResponse | undefined>(
    () => this.responses()[this.activeId()],
  );
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));

  constructor(private readonly id: () => string) {}

  open(request?: RequestDraft, documentId = '', path: number[] = []) {
    const id = this.id();
    this.tabs.update((t) => [
      ...t,
      { id, request: request ?? newRequest(id), documentId, path, dirty: false },
    ]);
    this.activeId.set(id);
    return id;
  }
  /** Keeps the response of a tab, which may no longer be the active one. */
  setResponse(id: string, response: ExecutionResponse | undefined) {
    this.responses.update((all) => {
      const { [id]: _previous, ...others } = all;
      return response ? { ...others, [id]: response } : others;
    });
  }
  /** Forgets every response, as when another workspace opens. */
  clearResponses() {
    this.responses.set({});
  }
  close(id: string) {
    this.tabs.update((t) => t.filter((x) => x.id !== id));
    this.setResponse(id, undefined);
    if (this.activeId() === id) this.activeId.set(this.tabs().at(-1)?.id ?? '');
  }
  /** Replaces the request of the active tab and marks it unsaved. */
  edit(request: RequestDraft) {
    const id = this.activeId();
    this.tabs.update((t) =>
      t.map((tab) => (tab.id === id ? { ...tab, request, dirty: true } : tab)),
    );
  }
  /** The tab already showing a collection item, if any. */
  find(documentId: string, path: readonly number[]) {
    return this.tabs().find(
      (t) => t.documentId === documentId && t.path.join('/') === path.join('/'),
    );
  }
  unsaved() {
    return this.tabs().some((tab) => tab.dirty);
  }
}
