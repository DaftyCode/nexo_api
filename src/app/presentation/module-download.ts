import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MODULES } from '../composition/providers';
import {
  InstallProgress,
  ModuleSummary,
  isInstalling,
  percent,
  sourceHost,
} from '../domain/modules';
import { formatBytes } from '../domain/sizes';
import { WorkspaceState } from './workspace-state';

/**
 * Asks before a database module is downloaded, as DBeaver does with its drivers: what it is,
 * how much it weighs, where it comes from and its licenses. Then downloads and installs it,
 * with its progress, and says why if it fails so it can be tried again.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-module-download',
  styleUrl: './module-download.scss',
  templateUrl: './module-download.html',
})
export class ModuleDownload {
  readonly module = input.required<ModuleSummary>();
  /** The module is installed and ready. */
  readonly installed = output<ModuleSummary>();
  /** The person closed the dialog without installing it. */
  readonly closed = output<void>();
  private readonly modules = inject(MODULES);
  private readonly state = inject(WorkspaceState);
  protected readonly progress = signal<InstallProgress | undefined>(undefined);
  protected readonly error = signal('');
  protected readonly busy = computed(() => isInstalling(this.progress()));
  protected readonly host = computed(() => sourceHost(this.module()));
  protected readonly bytes = formatBytes;
  protected readonly percent = percent;

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() =>
      element.nativeElement.querySelector<HTMLButtonElement>('.module-confirm')?.focus(),
    );
  }

  async download() {
    this.error.set('');
    const module = this.module();
    try {
      await this.modules.install(module.id, (progress) => this.progress.set(progress));
      this.installed.emit(module);
    } catch (error) {
      this.progress.set(undefined);
      this.error.set(this.state.describe(error));
    }
  }

  close() {
    if (!this.busy()) this.closed.emit();
  }
}
