import { signal } from '@angular/core';
import { moveWithin } from '../../domain/ordering';
import { sectionIds } from '../workspace/sections';
import { DocumentsStore } from './documents-store';
import { StateContext } from './state-context';

/** How long a change waits before the session is saved: tabs change at every keystroke. */
export const SESSION_SAVE_DELAY = 500;

/**
 * The session of the open workspace: reopened with it (tabs, unsaved changes, the active tab,
 * the section and the order of the collections) and saved shortly after each change.
 */
export class WorkspaceSessionStore {
  /** Whether tabs reopen with the workspace, on this device. */
  readonly restoresTabs = signal(true);
  /** Saving starts once the session of a workspace was restored and stops when it is left. */
  private armed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  /** The last session saved, to skip saving the same one again. */
  private last = '';
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
  ) {
    this.restoresTabs.set(context.cases.sessions.restoresTabs());
  }

  /**
   * Reopens the session of the workspace just loaded and starts saving it. Returns whether it
   * reopened tabs; tabs whose request was deleted are left out, and a toast says so.
   */
  restore(reopenTabs = true) {
    const { cases, tabs, status, section } = this.context;
    const current = this.documents.session();
    const stored = current ? cases.sessions.stored([current]) : undefined;
    this.revision = stored?.revision ?? 0;
    this.documents.collectionOrder.set(stored?.session.collections ?? []);
    let reopened = false;
    if (stored && reopenTabs && this.restoresTabs()) {
      const restored = cases.sessions.tabs(stored.session, this.documents.documents(), () =>
        cases.files.id(),
      );
      if (restored.tabs.length) {
        tabs.restore(restored.tabs, restored.activeTab);
        const shown = stored.session.section;
        section.set(shown && sectionIds.includes(shown) ? shown : 'collections');
        reopened = true;
      }
      if (restored.dropped)
        status.tell({
          kind: 'info',
          title: 'Some tabs were not reopened',
          message: 'toast.tabsDropped',
          params: { v0: String(restored.dropped) },
        });
    }
    this.last = '';
    this.armed = true;
    return reopened;
  }
  /** Reads what the session holds, so the effect that calls it runs on each change. */
  changed() {
    const { tabs, section } = this.context;
    tabs.tabs();
    tabs.activeId();
    section();
    this.documents.collectionOrder();
    this.restoresTabs();
    if (!this.armed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SESSION_SAVE_DELAY);
  }
  /** Saves the session now, if it changed. Saving it is a convenience: failures are quiet. */
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const workspace = this.context.workspaceId();
    if (!this.armed || !workspace) return this.saving;
    const { cases, tabs, section } = this.context;
    // Once ordered, the order of the collections that exist: deleted ones leave it.
    const order = this.documents.collectionOrder().length
      ? this.documents.collections().map((d) => d.id)
      : [];
    const value = {
      ...cases.sessions.of(tabs.tabs(), tabs.activeId(), order, this.documents.documents()),
      section: section(),
    };
    const text = JSON.stringify(value);
    if (text === this.last) return this.saving;
    this.last = text;
    this.saving = this.saving.then(async () => {
      try {
        this.revision = await cases.sessions.save(workspace, value, this.revision);
      } catch {
        // Saved again with the next change.
        this.last = '';
      }
    });
    return this.saving;
  }
  /** Saves what is pending and stops saving, before the workspace is left or closed. */
  async leave() {
    await this.flush();
    this.armed = false;
  }
  /** Turns reopening tabs on or off on this device; the session keeps the collection order. */
  setRestoresTabs(restore: boolean) {
    this.context.cases.sessions.setRestoresTabs(restore);
    this.restoresTabs.set(restore);
  }
  /** Moves a collection of the sidebar to a position counted before the move. */
  moveCollection(id: string, to: number) {
    const ids = this.documents.collections().map((d) => d.id);
    this.documents.collectionOrder.set(moveWithin(ids, ids.indexOf(id), to));
  }
}
