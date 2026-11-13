import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MODULES } from '../composition/providers';
import { ModuleState, ModuleSummary, connectionsOf } from '../domain/modules';
import { formatBytes } from '../domain/sizes';
import { ModuleDownload } from './module-download';
import { PanelTask } from './panel-task';
import { WorkspaceState, named } from './workspace-state';

/** What each state is called on screen. */
const STATES: Record<ModuleState, string> = {
  available: 'Not installed',
  installed: 'Installed',
  outdated: 'Needs an update',
  development: 'Development build',
};

/**
 * Settings → Modules: the database modules of this version of Nexo, installed when they are
 * first needed, updated, installed from a file without network, and removed.
 */
@Component({
  imports: [TranslocoPipe, ModuleDownload],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-modules-settings',
  styleUrl: './modules-settings.scss',
  templateUrl: './modules-settings.html',
})
export class ModulesSettings {
  private readonly modules = inject(MODULES);
  private readonly translator = inject(TranslocoService);
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  protected readonly list = signal<ModuleSummary[]>([]);
  protected readonly loaded = signal(false);
  /** The module whose download dialog is open. */
  protected readonly downloading = signal<ModuleSummary | undefined>(undefined);
  protected readonly autoUpdate = signal(this.modules.autoUpdate());
  protected readonly bytes = formatBytes;
  protected readonly stateLabel = (state: ModuleState) => STATES[state];

  constructor() {
    void this.load();
  }

  async load() {
    await this.task.run(async () => {
      this.list.set(await this.modules.list());
      this.loaded.set(true);
    });
  }

  setAutoUpdate(enabled: boolean) {
    this.modules.setAutoUpdate(enabled);
    this.autoUpdate.set(enabled);
  }

  installed(module: ModuleSummary) {
    this.downloading.set(undefined);
    this.state.showToast(named('Module installed', module.name));
    void this.load();
  }

  async remove(module: ModuleSummary) {
    const connections = connectionsOf(module.id, this.state.documents());
    const question = this.translator.translate(
      connections ? 'modules.remove.connections' : 'modules.remove.confirm',
      { v0: module.name, v1: String(connections) },
    );
    if (!this.state.confirm(question)) return;
    await this.task.announce('The module could not be removed', async () => {
      await this.modules.remove(module.id);
      await this.load();
      return named('Module removed', module.name);
    });
  }

  async installFile(event: Event) {
    const chooser = event.target as HTMLInputElement;
    const file = chooser.files?.[0];
    chooser.value = '';
    if (!file) return;
    await this.task.announce('The module could not be installed', async () => {
      const module = await this.modules.installFile(file);
      await this.load();
      return named('Module installed', module.name);
    });
  }
}
