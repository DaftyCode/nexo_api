import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import { failureCode } from '../application/ports';
import { readDbConnection } from '../domain/db/connection';
import { engineProfile } from '../domain/db/engines';
import { connectionTypes, typeOf } from '../domain/db/connection-types';
import {
  DbForm,
  emptyDbForm,
  formOf,
  formProblem,
  formUrl,
  typedSecrets,
  valueOf,
  withUrl,
} from '../domain/db/form';
import { parseDbUrl } from '../domain/db/url';
import { ModuleSummary } from '../domain/modules';
import { DbConnectionFields } from './db-connection-fields';
import { DbConnectionNetwork } from './db-connection-network';
import { DbConnectionStartup } from './db-connection-startup';
import { ConnectionChecks } from './db-connection-editor/checks';
import { EditorPage, PAGE_LABELS, editorPages } from './db-connection-editor/pages';
import { DbEngineGallery } from './db-engine-gallery';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { ModuleDownload } from './module-download';
import { PanelTask } from './panel-task';
import { named } from './workspace-state';

export type { EditorPage } from './db-connection-editor/pages';

/**
 * Creating or editing a connection of a database module: the engine first (its module is
 * downloaded then, if missing), then its settings by tabs. «Test connection» works before it
 * is saved; the password and the client key always go to the vault.
 */
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    DbEngineGallery,
    DbConnectionFields,
    DbConnectionNetwork,
    DbConnectionStartup,
    ModuleDownload,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-connection-editor',
  templateUrl: './db-connection-editor.html',
  styleUrl: './db-connection-editor.scss',
})
export class DbConnectionEditor {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  private readonly state = this.section.state;
  protected readonly task = new PanelTask(this.state);
  protected readonly step = signal<'engine' | 'form'>('engine');
  protected readonly page = signal<EditorPage>('main');
  protected readonly model = signal<DbForm>(emptyDbForm(''));
  protected readonly fields = form(this.model, (path) => {
    min(path.timeoutSeconds, 0);
    max(path.timeoutSeconds, 3600);
  });
  protected readonly notice = signal('');
  protected readonly download = signal<ModuleSummary | undefined>(undefined);
  /** The id the connection is saved with; its vault entries are named after it. */
  private id = '';
  /** Whether the vault may hold secrets of a connection that was never saved. */
  private unsavedSecrets = false;
  /** The type the form had, to notice the person changing it. */
  private type = '';

  protected readonly document = computed(() => this.section.connection(this.tab().connection));
  private readonly stored = computed(() => readDbConnection(this.document()?.value));
  protected readonly profile = computed(() => engineProfile(this.model().driver));
  protected readonly pages = computed(() => editorPages(this.profile()));
  protected readonly types = computed(() => connectionTypes(this.state.documents()));
  protected readonly pageLabels = PAGE_LABELS;
  /** How a URL of the engine looks, under the field where one is pasted. */
  protected readonly urlExample = computed(() =>
    this.profile().file
      ? 'jdbc:sqlite:C:/data/shop.db'
      : 'postgresql://user:password@localhost:5432/database',
  );
  protected readonly url = computed(() => formUrl(this.model()));
  protected readonly problem = computed(() => formProblem(this.model()));
  protected readonly passwordStored = computed(() => !!this.stored().password);
  protected readonly keyStored = computed(() => !!this.stored().tls?.keyPem);
  protected readonly proxyStored = computed(() => {
    const route = this.stored().route;
    return route?.via === 'socks5' && !!route.password;
  });
  /** «Test connection» and «Test the tunnel» of the form as it is written. */
  protected readonly checks = new ConnectionChecks({
    section: this.section,
    task: this.task,
    model: this.model,
    stored: this.stored,
    saved: () => !!this.document(),
    id: () => this.id,
    defaultPort: () => this.profile().defaultPort || undefined,
    problem: this.problem,
    typedUnsaved: () => (this.unsavedSecrets = true),
  });

  constructor() {
    effect(() => {
      const tab = this.tab();
      untracked(() => this.open(tab));
    });
    // As in DBeaver, a production connection starts with manual commits; others auto-commit.
    effect(() => {
      const chosen = this.model().type;
      if (chosen === this.type) return;
      this.type = chosen;
      // The type says whether its sessions commit each statement (DB-25).
      const auto = untracked(() => typeOf(chosen, this.state.documents()).rules.autoCommit);
      untracked(() => this.model.update((form) => ({ ...form, autoCommit: auto })));
    });
  }

  private open(tab: DbTab) {
    const document = this.section.connection(tab.connection);
    this.checks.clear();
    this.notice.set('');
    if (document) {
      this.id = document.id;
      this.model.set(formOf(document.name, document.value));
      this.type = this.model().type;
      this.step.set('form');
    } else {
      this.id ||= this.state.cases.files.id();
      this.step.set('engine');
    }
  }

  /** An engine of the gallery: its module is checked, and downloaded after asking. */
  protected choose(module: ModuleSummary) {
    void this.task.run(async () => {
      const need = await this.section.modules.ensure(module.id);
      if (need.ready) this.start(module);
      else this.download.set(need.module);
    });
  }

  protected start(module: ModuleSummary) {
    this.download.set(undefined);
    this.model.set(emptyDbForm(module.id, module.name));
    this.type = this.model().type;
    this.page.set('main');
    this.step.set('form');
  }

  /** Fills the form from a pasted URL; a password in it moves to the password field. */
  protected useUrl() {
    const text = this.model().url.trim();
    if (!text) return;
    void this.task.run(async () => {
      const modules = (await this.section.modules.list()).map((module) => module.id);
      const parsed = parseDbUrl(text, modules);
      if (this.document() && parsed.driver !== this.model().driver)
        throw new Error('This URL is for another database');
      this.model.update((model) => withUrl(model, parsed));
      this.notice.set(
        parsed.password !== undefined
          ? 'The password left the URL: it is saved in the vault with the connection.'
          : 'The form now shows this URL.',
      );
    });
  }

  private check() {
    const problem = this.problem();
    if (problem) throw new Error(problem);
  }

  protected test() {
    this.notice.set('');
    this.checks.test();
  }

  protected save() {
    this.notice.set('');
    void this.task.announce('The connection could not be saved', async () => {
      this.check();
      const cases = await this.section.cases();
      const model = this.model();
      const write = (existing = this.document()) =>
        cases.connections.save(
          this.state.workspaceId(),
          this.id,
          model.name,
          valueOf(model, readDbConnection(existing?.value)),
          typedSecrets(model),
          existing,
        );
      let saved;
      try {
        saved = await write();
      } catch (error) {
        if (failureCode(error) !== 'conflict') throw error;
        // Changed elsewhere since it was opened: reload it and let the person choose.
        await this.state.refresh();
        const latest = this.section.connection(this.id);
        const message =
          'This connection changed since you opened it. Save your changes over the latest version?';
        if (!latest || !this.state.confirm(message)) return undefined;
        saved = await write(latest);
      }
      this.unsavedSecrets = false;
      await this.state.refresh();
      this.section.tabs.update(this.tab().id, { connection: saved.id, title: saved.name });
      this.section.active.set(saved.id);
      this.model.update((form) => ({
        ...form,
        password: '',
        keyPem: '',
        route: { ...form.route, password: '' },
      }));
      // The navigator connects again with the new settings.
      if (this.section.tree.status()[saved.id] === 'connected')
        await this.section.tree.disconnect(saved.id);
      return named('Connection saved', saved.name);
    });
  }

  /** Closes the editor; a connection tested but never saved leaves nothing in the vault. */
  protected close() {
    if (this.unsavedSecrets && !this.document()) {
      const id = this.id;
      void this.section.cases().then((cases) => cases.connections.forget(id));
    }
    this.section.tabs.close(this.tab().id);
  }

  protected copyUrl() {
    void this.task.run(async () => {
      await globalThis.navigator?.clipboard?.writeText(this.url());
      this.notice.set('URL copied, without the password');
    });
  }
}
