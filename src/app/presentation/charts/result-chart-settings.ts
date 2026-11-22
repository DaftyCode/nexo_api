import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CHART_AGGREGATES, CHART_TYPES, ResultChartConfig } from '../../domain/db/result-chart';
import type { ResultColumn } from '../../domain/db/results';

/** The settings of a result chart: its type, axes, series, aggregation, order and names. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-result-chart-settings',
  templateUrl: './result-chart-settings.html',
  styleUrl: './result-chart-settings.scss',
})
export class ResultChartSettings {
  readonly config = input.required<ResultChartConfig>();
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly changed = output<Partial<ResultChartConfig>>();
  protected readonly types = CHART_TYPES;
  protected readonly aggregates = CHART_AGGREGATES;

  protected set(patch: Partial<ResultChartConfig>) {
    this.changed.emit(patch);
  }
  protected value(event: Event) {
    return (event.target as HTMLInputElement).value;
  }
  protected toggleY(name: string) {
    const y = this.config().y;
    this.set({ y: y.includes(name) ? y.filter((each) => each !== name) : [...y, name] });
  }
}
