import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import {
  FRAME,
  Series,
  barChart,
  timeAt,
  timeChart,
  timeLabel,
  valuesAt,
} from '../../domain/chart';
import { ChartKind, formatValue } from '../../domain/db/dashboard';

/** Rows the table of a chart shows: the latest readings. */
const TABLE_ROWS = 20;
/** Series colors, from the theme's tokens (see `chart.scss`). */
const COLORS = 8;

/**
 * A chart of our own, in SVG with no library: series over time as lines or areas, values as
 * bars, or the last value large. With its axes, its legend, the values under the pointer,
 * and the same numbers as a table for a screen reader or whoever prefers them. Shared by the
 * dashboards (DB-22) and the charts of results (DB-28).
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-chart',
  templateUrl: './chart.html',
  styleUrl: './chart.scss',
})
export class Chart {
  readonly kind = input<ChartKind>('line');
  readonly series = input<readonly Series[]>([]);
  readonly unit = input('');
  /** The values are per second. */
  readonly perSecond = input(false);
  /** What the chart shows, for its accessible name. */
  readonly label = input.required<string>();
  protected readonly frame = FRAME;
  protected readonly table = signal(false);
  protected readonly hoverAt = signal<number | undefined>(undefined);

  protected readonly hasData = computed(() => this.series().some((each) => each.points.length));
  protected readonly time = computed(() => timeChart(this.series()));
  /** The last value of each series. */
  protected readonly latest = computed(() =>
    this.series().map((each) => ({ name: each.name, value: each.points.at(-1)?.value })),
  );
  protected readonly bars = computed(() =>
    barChart(
      this.latest().flatMap((each) =>
        each.value === undefined ? [] : [{ name: each.name, value: each.value }],
      ),
    ),
  );
  protected readonly hovered = computed(() => {
    const at = this.hoverAt();
    if (at === undefined) return undefined;
    const values = valuesAt(this.series(), at);
    if (!values.length) return undefined;
    const time = this.time();
    const x =
      time.end > time.start
        ? FRAME.left +
          ((values[0].at - time.start) / (time.end - time.start)) *
            (FRAME.width - FRAME.left - FRAME.right)
        : FRAME.left;
    return { x, at: values[0].at, values };
  });
  /** The same numbers as rows: a time per row and a column per series, the latest first. */
  protected readonly rows = computed(() => {
    const times = [...new Set(this.series().flatMap((each) => each.points.map((p) => p.at)))]
      .sort((a, b) => b - a)
      .slice(0, TABLE_ROWS);
    return times.map((at) => ({
      at,
      values: this.series().map((each) => each.points.find((point) => point.at === at)?.value),
    }));
  });
  /** What a screen reader hears of the chart: its last values. */
  protected readonly summary = computed(() =>
    [this.label(), ...this.latest().map((each) => `${each.name}: ${this.format(each.value)}`)].join(
      '. ',
    ),
  );

  protected format(value: number | undefined) {
    return value === undefined ? '—' : formatValue(value, this.unit(), this.perSecond());
  }
  protected color(index: number) {
    return `chart-series-${index % COLORS}`;
  }
  protected readonly timeLabel = timeLabel;

  protected hover(event: PointerEvent) {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    if (!box.width) return;
    const x = ((event.clientX - box.left) / box.width) * FRAME.width;
    this.hoverAt.set(timeAt(this.time(), x));
  }
}
