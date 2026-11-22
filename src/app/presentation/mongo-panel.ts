import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState, named, success } from './workspace-state';
import { PanelTask } from './panel-task';
import { MONGO } from '../composition/providers';
import { MongoConnectionSettings } from './mongo-connection-settings';
import { WorkspaceDocument } from '../domain/models';
import {
  CONNECTION_COLORS,
  ConnectionForm,
  ConnectionReport,
  MongoConnectionValue,
  connectionFolders,
  connectionProblem,
  connectionValue,
  emptyConnectionForm,
  formatMongoUri,
  isMongoConnection,
  isVaultReference,
  parseMongoUri,
} from '../domain/mongo';
import { readRoute, routeProblem } from '../domain/route';
import { PanelModel, emptyModel, storedValue, typedSecrets } from './mongo-panel/model';

type Tab = 'server' | 'authentication' | 'tls' | 'options' | 'route';
export type { PanelModel } from './mongo-panel/model';

/**
 * A MongoDB connection, in its tab of the databases section (DB-39): kept in the workspace
 * with its password in the vault, edited from a URI or field by field, and tested against
 * the egress policy before anything is sent.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoConnectionSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-panel',
  styleUrl: './mongo-panel.scss',
  templateUrl: './mongo-panel.html',
})
export class MongoPanel {
  /** The saved connection edited, or none for a new one. */
  readonly connectionId = input('');
  /** Saved: the tab now belongs to it. */
  readonly saved = output<WorkspaceDocument>();
  readonly removed = output<void>();
  /** «Browse data»: its explorer. */
  readonly explore = output<WorkspaceDocument>();
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  private readonly mongo = inject(MONGO);
  protected readonly tabs: readonly Tab[] = ['server', 'authentication', 'tls', 'options', 'route'];
  protected readonly tab = signal<Tab>('server');
  protected readonly colors = CONNECTION_COLORS;
  protected readonly model = signal<PanelModel>(emptyModel());
  protected readonly fields = form(this.model);
  /** The connection being edited, or none for a new one. */
  protected readonly selectedId = signal('');
  protected readonly report = signal<ConnectionReport | undefined>(undefined);
  /** What the last action did, as a message key with its values. */
  protected readonly notice = signal<{ key: string; params?: Record<string, unknown> }>({
    key: '',
  });

  protected readonly connections = computed(() => this.state.documents().filter(isMongoConnection));
  protected readonly folders = computed(() => connectionFolders(this.connections()));
  protected readonly folderNames = computed(() =>
    this.folders()
      .map((group) => group.folder)
      .filter(Boolean),
  );
  protected readonly selected = computed(() =>
    this.connections().find((document) => document.id === this.selectedId()),
  );
  private readonly stored = computed(() => connectionValue(this.selected()?.value));
  protected readonly uri = computed(() => formatMongoUri(this.model()));
  protected readonly problem = computed(
    () => connectionProblem(this.model()) ?? routeProblem(this.model().route),
  );
  protected readonly passwordStored = computed(() => !!this.stored().password);
  protected readonly keyStored = computed(() => !!this.stored().keyPem);

  constructor() {
    effect(() => {
      const id = this.connectionId();
      untracked(() => {
        const document = this.connections().find((connection) => connection.id === id);
        if (document) this.open(document);
        else this.newConnection();
      });
    });
  }

  protected newConnection() {
    this.selectedId.set('');
    this.model.set(emptyModel());
    this.report.set(undefined);
    this.notice.set({ key: '' });
    this.task.error.set('');
    this.tab.set('server');
  }

  protected open(document: WorkspaceDocument) {
    const value = connectionValue(document.value);
    let parsed: ConnectionForm = emptyConnectionForm();
    try {
      parsed = parseMongoUri(value.uri).form;
    } catch (error) {
      this.task.error.set(this.state.describe(error));
    }
    this.selectedId.set(document.id);
    this.model.set({
      ...emptyModel(),
      ...parsed,
      name: document.name,
      folder: value.folder ?? '',
      color: value.color ?? '',
      readOnly: !!value.readOnly,
      mcp: !!value.mcp,
      mcpHidden: (value.mcpHidden ?? []).join(', '),
      caPem: value.caPem ?? '',
      certPem: value.certPem ?? '',
      route: readRoute(value.nexoRoute),
    });
    this.report.set(undefined);
    this.notice.set({ key: '' });
  }

  /** Fills the form from a pasted URI; a password in it moves to the password field. */
  protected useUri() {
    const text = this.model().paste.trim();
    if (!text) return;
    try {
      const parsed = parseMongoUri(text);
      this.model.update((model) => ({
        ...model,
        ...parsed.form,
        password: parsed.password ?? model.password,
        paste: '',
      }));
      this.task.error.set('');
      this.notice.set({
        key:
          parsed.password !== undefined
            ? 'The password left the URI: it is saved in the vault with the connection.'
            : 'The form now shows this URI.',
      });
    } catch (error) {
      this.task.error.set(this.state.describe(error));
    }
  }

  private value(): MongoConnectionValue {
    return storedValue(this.model(), this.stored(), this.uri());
  }
  private typed() {
    return typedSecrets(this.model());
  }
  private check() {
    const problem = this.problem();
    if (problem) throw new Error(problem);
  }

  protected save() {
    this.notice.set({ key: '' });
    void this.task.announce('The connection could not be saved', async () => {
      this.check();
      const saved = await (
        await this.mongo()
      ).connections.save(
        this.state.workspaceId(),
        this.model().name,
        this.value(),
        this.typed(),
        this.selected(),
      );
      await this.state.refresh();
      this.selectedId.set(saved.id);
      this.model.update((model) => ({ ...model, name: saved.name, password: '', keyPem: '' }));
      this.saved.emit(saved);
      return named('Connection saved', saved.name);
    });
  }

  protected test() {
    this.report.set(undefined);
    this.notice.set({ key: '' });
    void this.task.run(async () => {
      this.check();
      this.report.set(
        await (
          await this.mongo()
        ).connections.test(
          this.state.workspaceId(),
          this.value(),
          this.typed(),
          this.state.scopes(),
        ),
      );
    });
  }

  protected remove() {
    const document = this.selected();
    if (!document || !this.state.confirm('Delete this connection? Its password leaves the vault.'))
      return;
    void this.task.announce('The connection could not be deleted', async () => {
      await (await this.mongo()).connections.remove(document);
      await this.state.refresh();
      this.removed.emit();
      return named('Connection deleted', document.name);
    });
  }

  protected copyUri() {
    void this.task.run(async () => {
      await globalThis.navigator?.clipboard?.writeText(this.uri());
      this.notice.set({ key: 'URI copied, without the password' });
    });
  }

  protected importCompass(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.notice.set({ key: '' });
    void this.task.announce('The connections could not be imported', async () => {
      const text = await this.state.cases.files.read(file);
      const saved = await (
        await this.mongo()
      ).connections.importCompass(this.state.workspaceId(), text);
      await this.state.refresh();
      input.value = '';
      return success('Import completed', 'mongo.imported', { v0: String(saved.length) });
    });
  }

  protected setColor(color: string) {
    this.model.update((model) => ({ ...model, color }));
  }
  protected hostCount() {
    return this.model()
      .hosts.split(/[\n,]/)
      .filter((host) => host.trim()).length;
  }
  protected vaultReference(text: string) {
    return isVaultReference(text);
  }
}
