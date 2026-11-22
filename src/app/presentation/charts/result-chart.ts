import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ResultChartConfig, autoChart, chartData } from '../../domain/db/result-chart';
import { CHART_FRAME, ChartShape, chartGeometry } from '../../domain/db/result-chart/geometry';
import type { ResultColumn } from '../../domain/db/results';
import { pngOf, svgImage } from '../db-diagram/export';
import { PanelTask } from '../panel-task';
import { WorkspaceState } from '../workspace-state';
import { inlineStyles } from './inline-styles';
import { ResultChartSettings } from './result-chart-settings';

/** Series colors and patterns, from the theme's tokens (see `result-chart.scss`). */
const STYLES = 8;
/** Shapes a keyboard can stop on, at most; the table has every value. */
const FOCUSABLE = 300;

/**
 * The «Chart» view of a result (DB-28): its type, the X column, the series and how repeated
 * values are aggregated, chosen on its own the first time and kept with the script. An SVG of
 * our own with its axes, a legend that hides and shows series, the value under the pointer or
 * the keyboard, the same numbers as a table, and SVG, PNG and print. It charts the rows
 * loaded, and says when there are more.
 */
@Component({
  imports: [TranslocoPipe, ResultChartSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-result-chart',
  templateUrl: './result-chart.html',
  styleUrl: './result-chart.scss',
})
export class ResultChart {
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly rows = input.required<readonly (readonly unknown[])[]>();
  /** More rows can be read than the grid has. */
  readonly more = input(false);
  readonly saved = input<ResultChartConfig | undefined>(undefined);
  readonly name = input('chart');
  readonly changed = output<ResultChartConfig>();
  readonly readAll = output<void>();
  private readonly state = inject(WorkspaceState);
  private readonly i18n = inject(TranslocoService);
  protected readonly task = new PanelTask(this.state);
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('chart');
  protected readonly frame = CHART_FRAME;
  /** An id of this chart's own, for its patterns. */
  protected readonly id = `chart-${Math.random().toString(36).slice(2, 9)}`;
  protected readonly styles = Array.from({ length: STYLES }, (_, at) => at);
  protected readonly hidden = signal<ReadonlySet<number>>(new Set());
  protected readonly table = signal(false);
  protected readonly active = signal<ChartShape | undefined>(undefined);
  protected readonly config = computed(() => this.saved() ?? autoChart(this.columns()));
  protected readonly data = computed(() => chartData(this.config(), this.columns(), this.rows()));
  protected readonly shown = computed(() =>
    this.data()
      .series.map((_, at) => at)
      .filter((at) => !this.hidden().has(at)),
  );
  protected readonly geometry = computed(() =>
    chartGeometry(this.data(), this.config().type, this.shown(), this.config().log),
  );
  protected readonly focusable = FOCUSABLE;
  /** What a screen reader hears: the title, the number of categories and of series. */
  protected readonly summary = computed(() =>
    this.i18n.translate('db.chart.summary', {
      v0: this.config().title || this.config().x,
      v1: this.data().categories.length,
      v2: this.shown().length,
    }),
  );

  protected set(patch: Partial<ResultChartConfig>) {
    this.hidden.set(new Set());
    this.changed.emit({ ...this.config(), ...patch });
  }
  protected toggleSeries(index: number) {
    this.hidden.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }
  protected style(index: number) {
    return `rc-series-${index % STYLES}`;
  }
  protected label(category: number) {
    const found = this.data().categories[category];
    return !found ? '' : found.rest ? this.i18n.translate('The rest') : found.label;
  }
  protected format(value: number | null | undefined) {
    if (value === null || value === undefined) return '—';
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  /** What a shape says, for the pointer, the keyboard and a screen reader. */
  protected describe(shape: ChartShape) {
    const series =
      this.config().type === 'pie'
        ? this.data().series[this.shown()[0]]
        : this.data().series[shape.series];
    return `${series?.name ?? ''} · ${this.label(shape.category)}: ${this.format(shape.value)}`;
  }

  private file() {
    return (this.config().title || this.name()).replace(/[^\w.-]+/g, '-') || 'chart';
  }
  /** The chart as an SVG of its own, its colors written in. */
  private svgText() {
    const svg = this.svg()?.nativeElement;
    return svg ? inlineStyles(svg) : '';
  }
  protected exportSvg() {
    void this.state.download(`${this.file()}.svg`, this.svgText(), 'image/svg+xml');
  }
  protected exportPng() {
    void this.task.run(async () => {
      const png = await pngOf(this.svgText(), CHART_FRAME.width, CHART_FRAME.height);
      await this.state.download(`${this.file()}.png`, png, 'image/png');
    });
  }
  protected print() {
    this.state.report.set(
      this.state.reports.diagramReport(this.config().title || this.config().x, {
        image: svgImage(this.svgText()),
        entities: this.data().categories.length,
        relations: this.shown().length,
        caption: {
          key: 'db.chart.printed',
          params: {
            v0: this.data().categories.length,
            v1: this.shown().length,
            v2: this.rows().length,
          },
        },
      }),
    );
  }
}
