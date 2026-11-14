import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { MODULES } from '../composition/providers';
import { ModuleSummary, isReady } from '../domain/modules';
import { formatBytes } from '../domain/sizes';
import { WorkspaceState } from './workspace-state';

/**
 * The first step of a new connection, as DBeaver's: every engine Nexo has a module for, the
 * installed ones first, with a search. Choosing one that is missing downloads its module.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-engine-gallery',
  templateUrl: './db-engine-gallery.html',
  styleUrl: './db-engine-gallery.scss',
})
export class DbEngineGallery {
  readonly chosen = output<ModuleSummary>();
  private readonly modules = inject(MODULES);
  private readonly state = inject(WorkspaceState);
  protected readonly all = signal<readonly ModuleSummary[] | undefined>(undefined);
  protected readonly error = signal('');
  protected readonly search = signal({ text: '' });
  protected readonly searchFields = form(this.search);
  protected readonly bytes = formatBytes;
  protected readonly ready = isReady;
  protected readonly shown = computed(() => {
    const wanted = this.search().text.trim().toLowerCase();
    return [...(this.all() ?? [])]
      .filter(
        (module) =>
          !wanted ||
          module.name.toLowerCase().includes(wanted) ||
          module.description.toLowerCase().includes(wanted),
      )
      .sort((a, b) => Number(isReady(b)) - Number(isReady(a)) || a.name.localeCompare(b.name));
  });

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set('');
    try {
      this.all.set(await this.modules.list());
    } catch (error) {
      this.all.set([]);
      this.error.set(this.state.describe(error));
    }
  }
}
