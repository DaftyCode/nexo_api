import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import { readEnvironmentSettings } from '../domain/environment-protection';
import { asCollection } from '../domain/models';
import {
  EVERY_HOURS,
  EVERY_MINUTES,
  MonitorForm as MonitorFormModel,
  collectionFolders,
  monitorProblem,
} from '../domain/monitors';
import { WorkspaceState } from './workspace-state';

/** The form of a monitor: what it runs, when, with which data and what it may do. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-monitor-form',
  styleUrl: './monitor-form.scss',
  templateUrl: './monitor-form.html',
})
export class MonitorForm {
  protected readonly state = inject(WorkspaceState);
  /** The monitor as it starts in the form. */
  readonly initial = input.required<MonitorFormModel>();
  /** Whether it is a monitor not saved yet. */
  readonly creating = input(false);
  readonly save = output<MonitorFormModel>();
  readonly cancelled = output<void>();
  protected readonly model = linkedSignal(() => this.initial());
  protected readonly fields = form(this.model, (p) => {
    min(p.iterations, 1);
    max(p.iterations, 1000);
    min(p.delay, 0);
    max(p.delay, 60_000);
  });
  protected readonly everyMinutes = EVERY_MINUTES;
  protected readonly everyHours = EVERY_HOURS;
  protected readonly folders = computed(() => {
    const collection = this.state.collections().find((d) => d.id === this.model().collection);
    return collection ? collectionFolders(asCollection(collection.value).item) : [];
  });
  /** The protection of the chosen environment: a monitor cannot ask before changes. */
  protected readonly protection = computed(() => {
    const environment = this.state.environments().find((d) => d.id === this.model().environment);
    return environment ? readEnvironmentSettings(environment.value).protection : 'none';
  });
  protected readonly problem = computed(() => monitorProblem(this.model()));

  /** Saves what the selects show: a folder of the collection chosen, a value of the unit. */
  protected submit() {
    if (this.problem()) return;
    const model = this.model();
    const allowed = (model.unit === 'hours' ? EVERY_HOURS : EVERY_MINUTES) as readonly number[];
    this.save.emit({
      ...model,
      folder: this.folders().some((folder) => folder.id === model.folder) ? model.folder : '',
      every: allowed.includes(Number(model.every)) ? model.every : String(allowed[0]),
    });
  }
}
