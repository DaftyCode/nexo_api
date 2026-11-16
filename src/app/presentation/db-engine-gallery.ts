import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
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
import { engineProfile } from '../domain/db/engines';
import { ModuleSummary, isReady } from '../domain/modules';
import { formatBytes } from '../domain/sizes';
import { StudioIcon } from './studio-icon';
import { WorkspaceState } from './workspace-state';

/** The icon a module's driver brings in its folder (`backend/drivers/nexo-driver-<id>`). */
export const engineIcon = (id: string) => `engines/nexo-driver-${id}/icon.svg`;

/**
 * The first step of a new connection, as DBeaver's: every engine Nexo has a module for, the
 * installed ones first, with its icon, what it is and a search. Choosing one that is missing
 * downloads its module.
 */
@Component({
  imports: [TranslocoPipe, FormField, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-engine-gallery',
  templateUrl: './db-engine-gallery.html',
  styleUrl: './db-engine-gallery.scss',
})
export class DbEngineGallery {
  readonly chosen = output<ModuleSummary>();
  private readonly modules = inject(MODULES);
  private readonly state = inject(WorkspaceState);
  private readonly i18n = inject(TranslocoService);
  protected readonly all = signal<readonly ModuleSummary[] | undefined>(undefined);
  protected readonly error = signal('');
  protected readonly search = signal({ text: '' });
  protected readonly searchFields = form(this.search);
  protected readonly bytes = formatBytes;
  protected readonly ready = isReady;
  /** Modules whose driver brings no icon: they show the plain database one. */
  protected readonly plain = signal<ReadonlySet<string>>(new Set());
  protected readonly searching = computed(() => !!this.search().text.trim());
  protected readonly shown = computed(() => {
    const wanted = this.search().text.trim().toLowerCase();
    return [...(this.all() ?? [])]
      .map((module) => {
        const profile = engineProfile(module.id, module.name);
        return {
          module,
          name: profile.name,
          summary: profile.summary,
          badge: profile.badge,
          icon: engineIcon(module.id),
        };
      })
      .filter(
        (card) =>
          !wanted ||
          [
            card.name,
            card.module.name,
            card.module.description,
            card.summary ? this.i18n.translate(card.summary) : '',
          ].some((text) => text.toLowerCase().includes(wanted)),
      )
      .sort(
        (a, b) =>
          Number(isReady(b.module)) - Number(isReady(a.module)) || a.name.localeCompare(b.name),
      );
  });

  constructor() {
    void this.load();
  }

  protected noIcon(id: string) {
    this.plain.update((plain) => new Set([...plain, id]));
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
