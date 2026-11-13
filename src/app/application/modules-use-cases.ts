import { ExecutionPort, FilePort, PreferencePort } from './ports';
import { InstallProgress, ModuleSummary, isInstalling, isReady } from '../domain/modules';

/** The preference that installs a newer module by itself when an outdated one is needed. */
const AUTO_UPDATE = 'modules.autoUpdate';
/** How often an installation is asked how it goes. */
const POLL = 250;

/** What a connection needs before it can use a module. */
export type ModuleNeed = { ready: true } | { ready: false; module: ModuleSummary };

/** The database modules: list them, download them with their progress, install, remove. */
export class ModulesUseCases {
  constructor(
    private readonly api: ExecutionPort,
    private readonly files: Pick<FilePort, 'readBase64'>,
    private readonly preferences: PreferencePort,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
  ) {}

  list(): Promise<ModuleSummary[]> {
    return this.api.execute<ModuleSummary[]>('modules.list', {});
  }

  /**
   * Downloads and installs a module, telling `progress` how it goes, and resolves when it is
   * installed. A failed installation rejects with the backend's reason.
   */
  async install(id: string, progress?: (state: InstallProgress) => void): Promise<void> {
    let state = await this.api.execute<InstallProgress>('modules.install', { id });
    progress?.(state);
    while (isInstalling(state)) {
      await this.wait(POLL);
      state = await this.api.execute<InstallProgress>('modules.progress', { id });
      progress?.(state);
    }
    if (state.state === 'failed') throw new Error(state.error || 'The module was not installed');
  }

  /** Installs a module from a file the person chose: a release file or the driver. */
  async installFile(file: File): Promise<ModuleSummary> {
    const content = await this.files.readBase64(file);
    return this.api.execute<ModuleSummary>('modules.install.file', { content });
  }

  remove(id: string): Promise<void> {
    return this.api.execute<void>('modules.remove', { id });
  }

  autoUpdate(): boolean {
    return this.preferences.read(AUTO_UPDATE) === 'true';
  }
  setAutoUpdate(enabled: boolean): void {
    this.preferences.write(AUTO_UPDATE, enabled ? 'true' : '');
  }

  /**
   * Whether a module can be used now. An outdated one is updated here, without asking, when
   * the person chose to keep modules up to date; otherwise the caller asks before
   * downloading.
   */
  async ensure(id: string, progress?: (state: InstallProgress) => void): Promise<ModuleNeed> {
    const module = (await this.list()).find((candidate) => candidate.id === id);
    if (!module) throw new Error(`There is no ${id} module for this version of Nexo`);
    if (isReady(module)) return { ready: true };
    if (module.state === 'outdated' && this.autoUpdate()) {
      await this.install(id, progress);
      return { ready: true };
    }
    return { ready: false, module };
  }
}
