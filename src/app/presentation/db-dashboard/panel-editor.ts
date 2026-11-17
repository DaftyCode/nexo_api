import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { CHART_KINDS, ChartKind, Panel } from '../../domain/db/dashboard';
import type { DashboardRun } from '../db-panel/dashboard-run';
import { DbSection } from '../db-panel/section';

/** The chart kinds, as the editor names them. */
const CHARTS: Record<ChartKind, string> = {
  line: 'Line',
  area: 'Area',
  bar: 'Bars',
  value: 'Single value',
};

/**
 * A panel of the person's own on a dashboard: a title and a query that only reads, one row
 * (a series per numeric column) or several (a label and a value each), drawn as a chart.
 * The query is read once before the panel is kept: one that would write is refused.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-panel-editor',
  template: `
    <div class="modal-backdrop">
      <section
        class="modal db-panel-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-panel-editor-title"
        (keydown.escape)="closed.emit()"
      >
        <div class="modal-heading">
          <h2 id="db-panel-editor-title">
            {{ (panel() ? 'Edit panel' : 'New panel') | transloco }}
          </h2>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Close dialog' | transloco"
            (click)="closed.emit()"
          >
            ×
          </button>
        </div>
        <label class="field">{{ 'Title' | transloco }}<input [formField]="fields.title" /></label>
        <label class="field"
          >{{ 'Query' | transloco
          }}<textarea class="db-panel-sql" rows="6" [formField]="fields.sql"></textarea>
        </label>
        <p class="muted db-panel-hint">{{ 'db.dashboard.queryHint' | transloco }}</p>
        <div class="row db-panel-row">
          <label class="field"
            >{{ 'Chart' | transloco
            }}<select [formField]="fields.chart">
              @for (kind of kinds; track kind) {
                <option [value]="kind">{{ charts[kind] | transloco }}</option>
              }
            </select></label
          >
          <label class="field">{{ 'Unit' | transloco }}<input [formField]="fields.unit" /></label>
        </div>
        <label class="db-panel-check"
          ><input type="checkbox" [formField]="fields.delta" />{{
            'Counters: draw the change per second' | transloco
          }}</label
        >
        @if (error()) {
          <p class="db-panel-error" role="alert">{{ error() | transloco }}</p>
        }
        <div class="modal-actions">
          <button type="button" class="button" (click)="closed.emit()">
            {{ 'Cancel' | transloco }}
          </button>
          <button
            type="button"
            class="button primary"
            [disabled]="checking() || !model().title.trim() || !model().sql.trim()"
            (click)="save()"
          >
            {{ 'Save' | transloco }}
          </button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .db-panel-editor {
      display: grid;
      gap: var(--nexo-space-4);
    }
    .db-panel-sql {
      font-family: var(--nexo-font-mono);
    }
    .db-panel-row {
      gap: var(--nexo-space-5);
    }
    .db-panel-check {
      display: inline-flex;
      align-items: center;
      gap: var(--nexo-space-3);
    }
    .db-panel-hint,
    .db-panel-error {
      margin: 0;
      font-size: var(--nexo-font-size-xs);
    }
    .db-panel-error {
      color: var(--nexo-color-danger-text);
    }
  `,
})
export class DbPanelEditor {
  /** The panel changed; a new one when there is none. */
  readonly panel = input<Panel | undefined>(undefined);
  readonly run = input.required<DashboardRun>();
  readonly saved = output<Panel>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  protected readonly kinds = CHART_KINDS;
  protected readonly charts = CHARTS;
  protected readonly model = signal({
    title: '',
    sql: '',
    chart: 'line' as ChartKind,
    unit: '',
    delta: false,
  });
  protected readonly fields = form(this.model);
  protected readonly error = signal('');
  protected readonly checking = signal(false);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      const panel = this.panel();
      if (panel)
        this.model.set({
          title: panel.title,
          sql: panel.sql,
          chart: panel.chart,
          unit: panel.unit ?? '',
          delta: panel.delta,
        });
      host.querySelector<HTMLElement>('input')?.focus();
    });
  }

  /** Reads the query once, on the dashboard's session, and keeps the panel if it reads. */
  protected async save() {
    const value = this.model();
    this.error.set('');
    this.checking.set(true);
    try {
      const run = this.run();
      if (run.status() !== 'open') throw new Error('db.dashboard.closed');
      const cases = await this.section.cases();
      await cases.dashboards.read(this.section.state.workspaceId(), run.session, value.sql);
      const id = this.panel()?.id ?? `custom-${this.section.state.cases.files.id()}`;
      this.saved.emit({
        id,
        title: value.title.trim(),
        sql: value.sql.trim(),
        chart: value.chart,
        ...(value.unit.trim() ? { unit: value.unit.trim() } : {}),
        delta: value.delta,
        interval: this.panel()?.interval ?? 5,
        custom: true,
      });
    } catch (error) {
      this.error.set(this.section.state.describe(error));
    } finally {
      this.checking.set(false);
    }
  }
}
