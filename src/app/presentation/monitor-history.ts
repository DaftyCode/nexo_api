import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MONITOR_HISTORY_LIMIT, MonitorRun } from '../domain/monitors';

/** The last runs of a monitor, newest first, with what failed in each. */
@Component({
  imports: [TranslocoPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-monitor-history',
  styleUrl: './monitor-history.scss',
  template: `
    <h3>{{ 'Last runs' | transloco }}</h3>
    <p class="muted">{{ 'monitor.historyLimit' | transloco: { v0: limit } }}</p>
    @for (run of runs(); track $index) {
      <details class="monitor-run">
        <summary>
          <span
            class="status-pill"
            [class.failed]="run.state === 'failed' || run.state === 'error'"
            [class.skipped]="run.state === 'skipped'"
            >{{ 'monitor.state.' + run.state | transloco }}</span
          >
          <time [attr.datetime]="run.startedAt | date: 'yyyy-MM-ddTHH:mm:ss'">{{
            run.startedAt | date: 'medium'
          }}</time>
          <span class="muted">{{
            (run.trigger === 'manual' ? 'By hand' : 'On schedule') | transloco
          }}</span>
          @if (run.state !== 'skipped') {
            <span class="muted">{{ 'units.duration' | transloco: { v0: run.duration } }}</span>
            <span class="muted">{{
              'monitor.counts'
                | transloco
                  : { v0: run.requests, v1: run.passedAssertions, v2: run.failedAssertions }
            }}</span>
          }
        </summary>
        @if (run.error) {
          <p class="danger">{{ run.error | transloco }}</p>
        }
        @for (failure of run.failures; track $index) {
          <p class="monitor-failure">
            <strong>{{ failure.request }}</strong>
            @if (failure.assertion) {
              · {{ failure.assertion }}
            }
            @if (failure.error) {
              <span class="danger">{{ failure.error }}</span>
            }
          </p>
        }
        @if (!run.error && !run.failures.length) {
          <p class="muted">{{ 'Nothing failed.' | transloco }}</p>
        }
      </details>
    } @empty {
      <p class="muted">{{ 'It has not run yet.' | transloco }}</p>
    }
  `,
})
export class MonitorHistory {
  readonly runs = input.required<readonly MonitorRun[]>();
  protected readonly limit = MONITOR_HISTORY_LIMIT;
}
