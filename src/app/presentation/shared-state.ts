import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SHARED } from '../composition/providers';
import { WorkspaceDocument, asCollection, fromItem } from '../domain/models';
import { SharedLink, SharedPlace, itemAt, pathOf } from '../domain/shared';
import { WorkspaceState } from './workspace-state';
import { success } from './state/state-context';

/** How often the shared files are looked at: their size and time, on this computer only. */
export const SHARED_POLL = 3000;

/** The dialog of sharing: bring a collection in, share one, or see how one is shared. */
export type SharedDialog =
  { mode: 'link' } | { mode: 'share'; collection: string } | { mode: 'manage'; collection: string };

/**
 * The collections of the workspace shared by the team (C-01): their links, a look at their
 * files every few seconds while there is one, and what teammates changed shown at once,
 * each open tab kept on its own request even when the collection moved around it.
 */
@Injectable({ providedIn: 'root' })
export class SharedState {
  private readonly cases = inject(SHARED);
  private readonly state = inject(WorkspaceState);
  readonly links = signal<readonly SharedLink[]>([]);
  readonly byCollection = computed(
    () => new Map(this.links().map((link) => [link.collection, link] as const)),
  );
  readonly dialog = signal<SharedDialog | undefined>(undefined);
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor() {
    effect(() => {
      const workspace = this.state.workspaceId();
      untracked(() => void this.load(workspace));
    });
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  private async load(workspace: string) {
    if (!workspace) return;
    try {
      this.show(await this.cases.status(workspace));
      // Opening the workspace is when a collection on a server is asked again.
      if (this.links().length) await this.poll(true);
    } catch {
      this.show([]);
    }
  }

  /** Shows the links, and looks at their files while there is one. */
  show(links: readonly SharedLink[]) {
    this.links.set(links);
    if (links.length && !this.timer) this.timer = setInterval(() => void this.poll(), SHARED_POLL);
    if (!links.length && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Brings in step the collections whose file changed; on `opening`, those on a server too. */
  async poll(opening = false) {
    if (this.polling) return;
    this.polling = true;
    try {
      const workspace = this.state.workspaceId();
      const before = this.state.documents();
      const found = await this.cases.poll(workspace, opening);
      if (workspace !== this.state.workspaceId()) return;
      if (found.changed.length) await this.follow(found.changed, before);
      this.show(found.links);
    } catch {
      // Tried again at the next look.
    } finally {
      this.polling = false;
    }
  }

  /** Shows what teammates changed: each open tab on its request, unsaved work kept. */
  async follow(changed: readonly string[], before: readonly WorkspaceDocument[]) {
    const shown = this.state.tabs().flatMap((tab) => {
      if (!changed.includes(tab.documentId)) return [];
      const old = before.find((document) => document.id === tab.documentId);
      const id = itemAt(asCollection(old?.value).item, tab.path)?.id;
      return id ? [{ tab: tab.id, id }] : [];
    });
    await this.state.refresh();
    for (const { tab, id } of shown) {
      const open = this.state.tabs().find((each) => each.id === tab);
      const document = this.state.documents().find((each) => each.id === open?.documentId);
      const items = asCollection(document?.value).item;
      const path = pathOf(items, id);
      const item = path && itemAt(items, path);
      if (!open || !path || !item) continue;
      const request = open.dirty ? open.request : fromItem(item, open.request.id);
      this.state.tabsStore.tabs.update((tabs) =>
        tabs.map((each) => (each.id === tab ? { ...each, path, request } : each)),
      );
    }
    const names = changed
      .map((id) => this.state.documents().find((document) => document.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    this.state.tell(success('Updated from the shared file', 'shared.updated', { v0: names }));
  }

  private workspace() {
    return this.state.workspaceId();
  }

  /** Shares a collection; the team key, when there is one, to give to the team. */
  async share(collection: string, place: SharedPlace, encrypt: boolean, environments: string[]) {
    const shared = await this.cases.share(
      this.workspace(),
      collection,
      place,
      encrypt,
      environments,
    );
    await this.load(this.workspace());
    return shared.key ?? '';
  }
  /** Brings a shared collection in, with the team key when it is sealed. */
  async link(place: SharedPlace, key?: string) {
    const linked = await this.cases.link(this.workspace(), place, key);
    await this.state.refresh();
    await this.load(this.workspace());
    return linked.collection;
  }
  async sync(collection: string) {
    const before = this.state.documents();
    this.show(await this.cases.sync(this.workspace(), collection));
    await this.follow([collection], before);
  }
  async resolve(collection: string, id: string, keep: 'mine' | 'theirs') {
    const before = this.state.documents();
    this.show(await this.cases.resolve(this.workspace(), collection, id, keep));
    if (keep === 'mine') await this.follow([collection], before);
  }
  async unlink(collection: string) {
    this.show(await this.cases.unlink(this.workspace(), collection));
  }
  key(collection: string) {
    return this.cases.key(this.workspace(), collection);
  }
}
