import { signal } from '@angular/core';
import { WorkspaceDocument } from '../../domain/models';
import { ImportReport } from '../../domain/import-report';
import { EnvironmentSettings } from '../../domain/environment-protection';
import { VariableRow } from '../../domain/variables';
import { DocumentsStore } from './documents-store';
import { SessionStore } from './session-store';
import { StateContext, Toast, named, success } from './state-context';
import { VariablesStore } from './variables-store';

/** Variables not saved because they changed elsewhere and the person kept that version. */
const variablesReloaded: Toast = {
  kind: 'info',
  title: 'Variables not saved',
  message: 'They changed elsewhere and were reloaded with the latest values.',
};
/** What saving variables gave: the document saved, or nothing when the person kept the
 * version changed elsewhere. `undefined` when it failed. */
export type VariablesSave = { saved?: WorkspaceDocument } | undefined;

/**
 * Creating, renaming, importing, exporting, deleting and saving workspaces and documents,
 * each one said in a toast: what it did, why it did nothing, or why it failed.
 */
export class SavesStore {
  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
    private readonly variables: VariablesStore,
    private readonly session: SessionStore,
  ) {}

  private announce(failure: string, action: () => Promise<Toast | undefined>) {
    return this.context.status.announce(failure, action);
  }
  /**
   * Downloads a file and says so in a toast. The browser saves it in its downloads folder, or
   * asks where; Nexo cannot know which, nor when it ends. `content` may be prepared on the
   * way, so a failure to prepare it is told too.
   */
  download(name: string, content: string | Blob | (() => Blob), type?: string) {
    return this.announce('The file could not be downloaded', async () => {
      this.context.cases.files.download(
        name,
        typeof content === 'function' ? content() : content,
        type,
      );
      return success('File downloaded', 'toast.downloaded', { v0: name });
    });
  }
  createWorkspace(name: string) {
    return this.announce('The workspace could not be created', async () =>
      named('Workspace created', (await this.session.create(name)).name),
    );
  }
  renameWorkspace(name: string) {
    return this.announce('The workspace could not be renamed', async () => {
      await this.session.rename(name);
      return named('Workspace renamed', name.trim());
    });
  }
  deleteWorkspace() {
    const id = this.context.workspaceId();
    const name = this.session.workspaces().find((w) => w.id === id)?.name ?? '';
    return this.announce('The workspace could not be deleted', async () =>
      (await this.session.remove()) ? named('Workspace deleted', name) : undefined,
    );
  }
  createCollection(name: string) {
    return this.announce('The collection could not be created', async () =>
      named('Collection created', (await this.documents.createCollection(name)).name),
    );
  }
  /** The report of the last import of another tool's export, until the next import. */
  readonly imported = signal<ImportReport | undefined>(undefined);
  /** Imports content or, with `files`, the folder of a Bruno collection. */
  importContent(content: string, files?: readonly File[]) {
    this.imported.set(undefined);
    return this.announce('The import failed', async () => {
      const { document, report } = await this.documents.importContent(content, files);
      this.imported.set(report);
      this.variables.validate();
      return named('Import completed', document.name);
    });
  }
  /** Downloads a collection or environment as JSON, and says so. */
  export(document: WorkspaceDocument) {
    return this.announce('The file could not be downloaded', async () =>
      success('File downloaded', 'toast.downloaded', {
        v0: this.context.cases.export(document),
      }),
    );
  }
  remove(document: WorkspaceDocument) {
    return this.announce('It could not be deleted', async () => {
      await this.documents.remove(document);
      if (this.variables.environmentId() === document.id) this.variables.select('');
      return named('Deleted', document.name);
    });
  }
  /** Tells that the person kept variables changed elsewhere instead of saving theirs. */
  variablesReloaded() {
    this.context.status.tell(variablesReloaded);
  }
  async saveEnvironment(
    id: string,
    name: string,
    rows: readonly VariableRow[],
    settings?: EnvironmentSettings,
  ): Promise<VariablesSave> {
    let saved: WorkspaceDocument | undefined;
    const ok = await this.announce('The environment could not be saved', async () => {
      saved = await this.variables.saveEnvironment(id, name, rows, settings);
      return saved ? named('Environment saved', saved.name) : variablesReloaded;
    });
    return ok ? { saved } : undefined;
  }
  async saveGlobals(rows: readonly VariableRow[]): Promise<VariablesSave> {
    let saved: WorkspaceDocument | undefined;
    const ok = await this.announce('The global variables could not be saved', async () => {
      saved = await this.variables.saveGlobals(rows);
      return saved ? success('Global variables saved') : variablesReloaded;
    });
    return ok ? { saved } : undefined;
  }
}
