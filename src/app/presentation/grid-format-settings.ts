import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  linkedSignal,
  untracked,
} from '@angular/core';
import { FormField, form, maxLength } from '@angular/forms/signals';
import { GridFormats } from '../domain/db/grid/cells';
import { GridFormatsState } from './data-grid/formats';

const same = (a: GridFormats, b: GridFormats) =>
  a.nullText === b.nullText && a.decimal === b.decimal && a.dates === b.dates;

/** Settings → Modules: how the data grids write `NULL`, decimals and dates, as DBeaver's. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-format-settings',
  template: `
    <section [attr.aria-label]="'Data grid' | transloco">
      <h3>{{ 'Data grid' | transloco }}</h3>
      <p class="muted">{{ 'How the data grids write values' | transloco }}</p>
      <div class="row">
        <label class="field"
          >{{ 'NULL is written as' | transloco
          }}<input [formField]="fields.nullText" spellcheck="false"
        /></label>
        <label class="field"
          >{{ 'Decimal separator' | transloco }}
          <select [formField]="fields.decimal">
            <option value=".">{{ 'Point (1.5)' | transloco }}</option>
            <option value=",">{{ 'Comma (1,5)' | transloco }}</option>
          </select>
        </label>
        <label class="field"
          >{{ 'Dates' | transloco }}
          <select [formField]="fields.dates">
            <option value="iso">{{ 'As the server writes them (ISO 8601)' | transloco }}</option>
            <option value="local">{{ 'As this computer writes them' | transloco }}</option>
          </select>
        </label>
      </div>
    </section>
  `,
})
export class GridFormatSettings {
  private readonly state = inject(GridFormatsState);
  protected readonly model = linkedSignal(() => this.state.formats());
  protected readonly fields = form(this.model, (path) => {
    maxLength(path.nullText, 20);
  });

  constructor() {
    // A change of the form is saved at once, for every grid.
    effect(() => {
      const chosen = this.model();
      untracked(() => {
        if (!same(chosen, this.state.formats())) void this.state.set(chosen);
      });
    });
  }
}
