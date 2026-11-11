import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState, named, success } from './workspace-state';
import { PanelTask } from './panel-task';
import { CodeEditor } from './code-editor';
import { MongoExplorer } from './mongo-explorer';
import { MONGO } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import {
  AUTH_CHOICES,
  CONNECTION_COLORS,
  ConnectionForm,
  ConnectionReport,
  MongoConnectionValue,
  READ_PREFERENCES,
  connectionFolders,
  connectionProblem,
  connectionValue,
  emptyConnectionForm,
  formatMongoUri,
  isVaultReference,
  parseMongoUri,
} from '../domain/mongo';

type Tab = 'server' | 'authentication' | 'tls' | 'options' | 'ssh';

interface PanelModel extends ConnectionForm {
  name: string;
  folder: string;
  color: string;
  readOnly: boolean;
  /** Typed here; blank keeps what the vault has. */
  password: string;
  caPem: string;
  certPem: string;
  /** Typed here; blank keeps what the vault has. */
  keyPem: string;
  /** A URI pasted to fill the form. */
  paste: string;
}

function emptyModel(): PanelModel {
  return {
    ...emptyConnectionForm(),
    name: 'Local MongoDB',
    folder: '',
    color: '',
    readOnly: false,
    password: '',
    caPem: '',
    certPem: '',
    keyPem: '',
    paste: '',
  };
}

/**
 * MongoDB connections: kept in the workspace with their passwords in the vault, edited from
 * a URI or field by field, and tested against the egress policy before anything is sent.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoExplorer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-panel',
  styleUrl: './mongo-panel.scss',
  templateUrl: './mongo-panel.html',
})
export class MongoPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  private readonly mongo = inject(MONGO);
  protected readonly tabs: readonly Tab[] = ['server', 'authentication', 'tls', 'options', 'ssh'];
  protected readonly tab = signal<Tab>('server');
  protected readonly authChoices = AUTH_CHOICES;
  protected readonly readPreferences = READ_PREFERENCES;
  protected readonly colors = CONNECTION_COLORS;
  protected readonly model = signal<PanelModel>(emptyModel());
  protected readonly fields = form(this.model);
  /** The connection being edited, or none for a new one. */
  protected readonly selectedId = signal('');
  protected readonly report = signal<ConnectionReport | undefined>(undefined);
  /** The saved connection being browsed, or none while connections are edited. */
  protected readonly exploring = signal<WorkspaceDocument | undefined>(undefined);
  /** What the last action did, as a message key with its values. */
  protected readonly notice = signal<{ key: string; params?: Record<string, unknown> }>({
    key: '',
  });

  protected readonly connections = computed(() =>
    this.state.documents().filter((document) => document.kind === 'connection'),
  );
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
  protected readonly problem = computed(() => connectionProblem(this.model()));
  protected readonly passwordStored = computed(() => !!this.stored().password);
  protected readonly keyStored = computed(() => !!this.stored().keyPem);

  protected colorOf(document: WorkspaceDocument) {
    return connectionValue(document.value).color ?? '';
  }
  protected isReadOnly(document: WorkspaceDocument) {
    return !!connectionValue(document.value).readOnly;
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
      caPem: value.caPem ?? '',
      certPem: value.certPem ?? '',
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
    const model = this.model();
    const stored = this.stored();
    return {
      uri: this.uri(),
      ...(stored.password && model.auth !== 'none' ? { password: stored.password } : {}),
      ...(model.caPem.trim() ? { caPem: model.caPem.trim() } : {}),
      ...(model.certPem.trim() ? { certPem: model.certPem.trim() } : {}),
      ...(stored.keyPem && model.certPem.trim() ? { keyPem: stored.keyPem } : {}),
      ...(model.folder.trim() ? { folder: model.folder.trim() } : {}),
      ...(model.color ? { color: model.color } : {}),
      ...(model.readOnly ? { readOnly: true } : {}),
    };
  }
  private typed() {
    const model = this.model();
    return {
      ...(model.auth !== 'none' && model.password ? { password: model.password } : {}),
      ...(model.keyPem.trim() ? { keyPem: model.keyPem } : {}),
    };
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
      ).save(
        this.state.workspaceId(),
        this.model().name,
        this.value(),
        this.typed(),
        this.selected(),
      );
      await this.state.refresh();
      this.selectedId.set(saved.id);
      this.model.update((model) => ({ ...model, name: saved.name, password: '', keyPem: '' }));
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
        ).test(this.state.workspaceId(), this.value(), this.typed(), this.state.scopes()),
      );
    });
  }

  protected remove() {
    const document = this.selected();
    if (!document || !this.state.confirm('Delete this connection? Its password leaves the vault.'))
      return;
    void this.task.announce('The connection could not be deleted', async () => {
      await (await this.mongo()).remove(document);
      await this.state.refresh();
      this.newConnection();
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
      const saved = await (await this.mongo()).importCompass(this.state.workspaceId(), text);
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
