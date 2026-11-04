import { computed, signal } from '@angular/core';
import { ExecutionResponse, RequestDraft, RequestTab, newRequest } from '../domain/models';

/** Open request tabs, the active one and its last response. */
export class TabsStore {
  readonly tabs = signal<RequestTab[]>([]);
  readonly activeId = signal('');
  readonly response = signal<ExecutionResponse | undefined>(undefined);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));

  constructor(private readonly id: () => string) {}

  open(request?: RequestDraft, documentId = '', path: number[] = []) {
    const id = this.id();
    this.tabs.update((t) => [
      ...t,
      { id, request: request ?? newRequest(id), documentId, path, dirty: false },
    ]);
    this.activeId.set(id);
    this.response.set(undefined);
    return id;
  }
  close(id: string) {
    this.tabs.update((t) => t.filter((x) => x.id !== id));
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
