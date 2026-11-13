import { signal } from '@angular/core';
import { failureCode } from '../../application/ports';
import { Health, Workspace } from '../../domain/models';
import { DocumentsStore } from './documents-store';
import { StateContext } from './state-context';
import { VariablesStore } from './variables-store';
import type { WorkspaceSessionStore } from './workspace-session-store';

/** Connection to the local service, the browser session and the local workspaces. */
export class SessionStore {
  readonly ready = signal(false);
  readonly health = signal<Health | undefined>(undefined);
  readonly authenticated = signal(false);
  readonly workspaces = signal<Workspace[]>([]);

  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
    private readonly variables: VariablesStore,
    /** Reopens the tabs of each workspace and saves them; without it, a blank tab opens. */
    private readonly session?: WorkspaceSessionStore,
  ) {}

  async initialize() {
    const { cases } = this.context;
    await cases.initialize();
    this.health.set(await cases.health());
    try {
      await this.load();
      this.authenticated.set(true);
    } catch (error) {
      this.authenticated.set(false);
      if (!['unauthorized', 'forbidden'].includes(failureCode(error) ?? '')) throw error;
    }
    this.ready.set(true);
  }
  /** Closes the browser session of the web version. */
  async signOut() {
    await this.session?.leave();
    await this.context.cases.signOut();
    this.authenticated.set(false);
    this.documents.documents.set([]);
    this.context.tabs.tabs.set([]);
  }
  async create(name: string) {
    const workspace = await this.context.cases.createWorkspace(name);
    this.workspaces.set(await this.context.cases.workspaces());
    await this.select(workspace.id);
    return workspace;
  }
  /** Opens a workspace created elsewhere, such as a cloned repository. */
  async open(id: string) {
    this.workspaces.set(await this.context.cases.workspaces());
    await this.select(id);
  }
  async rename(name: string) {
    await this.context.cases.renameWorkspace(this.context.workspaceId(), name);
    this.workspaces.set(await this.context.cases.workspaces());
  }
  /** Deletes the current workspace after confirmation; returns whether it was deleted. */
  async remove() {
    const current = this.workspaces().find((w) => w.id === this.context.workspaceId());
    if (!current || !this.context.confirm('Delete this workspace and all its documents?'))
      return false;
    await this.context.cases.deleteWorkspace(current.id);
    this.workspaces.set(await this.context.cases.workspaces());
    // Its open requests are gone with it; do not ask to discard them.
    this.context.tabs.tabs.update((tabs) => tabs.map((tab) => ({ ...tab, dirty: false })));
    await this.select(this.workspaces()[0]?.id ?? '');
    return true;
  }
  /** Switches workspace; open requests with unsaved changes need confirmation. */
  async select(id: string) {
    const { tabs, workspaceId } = this.context;
    if (
      id !== workspaceId() &&
      tabs.unsaved() &&
      !this.context.confirm('Discard unsaved changes in open requests?')
    )
      return;
    await this.session?.leave();
    workspaceId.set(id);
    tabs.tabs.set([]);
    tabs.clearResponses();
    this.variables.environmentId.set('');
    await this.context.status.guard(() => this.documents.refresh());
    this.variables.restore();
    if (!this.session?.restore()) this.openBlankTab();
  }
  private async load() {
    const { cases, workspaceId } = this.context;
    this.workspaces.set(await cases.workspaces());
    if (!this.workspaces().some((w) => w.id === workspaceId()))
      workspaceId.set(this.workspaces()[0]?.id ?? '');
    await this.documents.refresh();
    this.variables.validate();
    this.variables.restore();
    const open = this.context.tabs.tabs().length > 0;
    const reopened = this.session?.restore(!open) ?? false;
    if (!open && !reopened) this.openBlankTab();
  }
  private openBlankTab() {
    this.context.tabs.open();
    this.context.section.set('collections');
  }
}
