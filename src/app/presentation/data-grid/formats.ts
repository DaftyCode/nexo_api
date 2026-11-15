import { Injectable, inject, signal } from '@angular/core';
import { DATABASES } from '../../composition/providers';
import { DEFAULT_FORMATS, GridFormats } from '../../domain/db/grid/cells';

/**
 * The formats of the data grids (Settings → Modules), shared by every grid: read from the
 * preferences once, and changed for all of them at once.
 */
@Injectable({ providedIn: 'root' })
export class GridFormatsState {
  private readonly databases = inject(DATABASES, { optional: true });
  private readonly chosen = signal<GridFormats>(DEFAULT_FORMATS);
  private loading?: Promise<void>;

  /** The formats chosen; the first read loads them. */
  readonly formats = () => {
    this.loading ??= this.databases
      ? this.databases().then((cases) => this.chosen.set(cases.statements.gridFormats()))
      : Promise.resolve();
    return this.chosen();
  };

  async set(formats: GridFormats) {
    this.chosen.set(formats);
    (await this.databases?.())?.statements.setGridFormats(formats);
  }
}
