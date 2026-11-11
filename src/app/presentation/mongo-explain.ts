import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { examinedRatio, explainPlan } from '../domain/mongo-explain';

/**
 * How the server runs a query: its stages in order, each with what it returned and examined,
 * a collection scan or a sort in memory marked, and the explain itself as JSON.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-explain',
  styleUrl: './mongo-explain.scss',
  templateUrl: './mongo-explain.html',
})
export class MongoExplain {
  /** The explain as the server answered it, in relaxed Extended JSON. */
  readonly explain = input.required<unknown>();
  protected readonly view = signal<'stages' | 'json'>('stages');
  protected readonly plan = computed(() => explainPlan(this.explain()));
  protected readonly ratio = computed(() => {
    const ratio = examinedRatio(this.plan());
    if (ratio === undefined) return '';
    return Number.isFinite(ratio) ? ratio.toFixed(ratio < 10 ? 1 : 0) : '∞';
  });
  protected readonly json = computed(() => JSON.stringify(this.explain(), null, 2));
}
