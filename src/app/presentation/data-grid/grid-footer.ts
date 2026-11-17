import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { StudioIcon } from '../studio-icon';

/**
 * The foot of a grid: what the screen around it puts there, exporting, the rows loaded and
 * shown, the rows chosen, and reading every row that is left.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-footer',
  templateUrl: './grid-footer.html',
  styleUrl: './grid-footer.scss',
})
export class GridFooter {
  readonly shown = input.required<number>();
  readonly loaded = input.required<number>();
  readonly chosen = input.required<number>();
  readonly more = input(false);
  readonly loading = input(false);
  readonly exported = output<MouseEvent>();
  readonly readAll = output<void>();
  private readonly i18n = inject(TranslocoService);

  protected number(value: number) {
    return new Intl.NumberFormat(this.i18n.getActiveLang()).format(value);
  }
}
