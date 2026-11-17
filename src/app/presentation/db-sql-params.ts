import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ParameterValue, ParametersQuestion } from './db-panel/sql-client';

/**
 * The values of a statement's parameters, as DBeaver asks for them: each `:name` (and each
 * `?` by its number) with its value and how it is sent (text, number or NULL), the last value
 * given offered again. They go bound, never written into the statement.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-params',
  template: `
    <div class="db-params-backdrop">
      <form
        class="feature-card db-params"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-params-title"
        (submit)="$event.preventDefault(); answer()"
        (keydown.escape)="question().answer(undefined)"
      >
        <h2 id="db-params-title">{{ 'The parameters of the statement' | transloco }}</h2>
        @for (name of names(); track name) {
          <div class="row db-param-row">
            <label class="field grow"
              >{{ name.startsWith(':') ? name : ('db.params.position' | transloco: { v0: name }) }}
              <input
                [value]="values()[key(name)]?.text ?? ''"
                [disabled]="values()[key(name)]?.as === 'null'"
                autocomplete="off"
                spellcheck="false"
                (input)="set(key(name), { text: $any($event.target).value })"
            /></label>
            <label class="field"
              >{{ 'Sent as' | transloco }}
              <select
                [value]="values()[key(name)]?.as ?? 'text'"
                (change)="set(key(name), { as: $any($event.target).value })"
              >
                <option value="text">{{ 'Text' | transloco }}</option>
                <option value="number">{{ 'Number' | transloco }}</option>
                <option value="null">NULL</option>
              </select>
            </label>
          </div>
        }
        <div class="row db-params-actions">
          <button type="submit" class="button primary">{{ 'Run' | transloco }}</button>
          <button type="button" class="button" (click)="question().answer(undefined)">
            {{ 'Cancel' | transloco }}
          </button>
        </div>
      </form>
    </div>
  `,
  styleUrl: './db-sql-params.scss',
})
export class DbSqlParams {
  readonly question = input.required<ParametersQuestion>();
  /** `:name` for named parameters, `1`, `2`… for positional ones. */
  protected readonly names = computed(() => [
    ...this.question().names.map((name) => `:${name}`),
    ...Array.from({ length: this.question().positional }, (_, at) => `${at + 1}`),
  ]);
  private readonly given = signal<Record<string, ParameterValue>>({});
  protected readonly values = computed(() => {
    const remembered = Object.fromEntries(
      this.question().names.map((name) => [
        name,
        { text: this.question().remembered[name] ?? '', as: 'text' as const },
      ]),
    );
    return { ...remembered, ...this.given() };
  });

  protected key(name: string) {
    return name.startsWith(':') ? name.slice(1) : name;
  }
  protected set(key: string, change: Partial<ParameterValue>) {
    this.given.update((given) => ({
      ...given,
      [key]: { ...{ text: '', as: 'text' as const }, ...this.values()[key], ...change },
    }));
  }
  protected answer() {
    this.question().answer(this.values());
  }
}
