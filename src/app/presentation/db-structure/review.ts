import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { StructureDraft } from '../db-panel/structure-draft';

/**
 * The statements of a change of structure before they run, as DBeaver's «Persist changes»:
 * what the driver wrote (editable), what to know first (a rebuild, a lock, data that may be
 * cut), whether a failure half way is undone, the name typed for a drop, and run or keep
 * them as a script instead.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-ddl-review',
  template: `
    @let d = draft();
    @if (d.plan(); as plan) {
      <div class="db-structure-backdrop">
        <section
          class="feature-card db-structure-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="db-ddl-review-title"
          (keydown.escape)="cancelled.emit()"
        >
          <h2 id="db-ddl-review-title">{{ 'The statements that make the change' | transloco }}</h2>
          @if (plan.warnings.length) {
            <ul class="db-structure-warnings" [attr.aria-label]="'Warnings' | transloco">
              @for (warning of plan.warnings; track $index) {
                <li>{{ warning | transloco }}</li>
              }
            </ul>
          }
          <p class="muted">
            {{
              (plan.transactional ? 'db.structure.transactional' : 'db.structure.notTransactional')
                | transloco
            }}
          </p>
          <textarea
            class="db-structure-script"
            spellcheck="false"
            [attr.aria-label]="'Statements' | transloco"
            [value]="d.script()"
            (input)="d.script.set($any($event.target).value)"
          ></textarea>
          @if (drops()) {
            <label class="field"
              >{{ 'db.structure.typeName' | transloco: { v0: name() }
              }}<input
                autocomplete="off"
                [value]="typed()"
                (input)="typed.set($any($event.target).value)"
            /></label>
          }
          @if (d.error()) {
            <p class="db-structure-error" role="alert">{{ d.error() | transloco }}</p>
          }
          <div class="row db-structure-actions">
            <button
              type="button"
              class="button primary"
              [class.danger]="drops()"
              [disabled]="d.busy() || (drops() && typed().trim() !== name())"
              (click)="ran.emit(drops() ? typed().trim() : undefined)"
            >
              {{ 'Run' | transloco }}
            </button>
            <button type="button" class="button" (click)="script.emit(d.script())">
              {{ 'Open in a script' | transloco }}
            </button>
            <button type="button" class="button" (click)="cancelled.emit()">
              {{ 'Cancel' | transloco }}
            </button>
          </div>
        </section>
      </div>
    }
  `,
  styleUrl: './dialog.scss',
})
export class DbDdlReview {
  readonly draft = input.required<StructureDraft>();
  /** The table's name, typed to drop it. */
  readonly name = input('');
  /** Run, with the name typed when the statements drop something. */
  readonly ran = output<string | undefined>();
  readonly script = output<string>();
  readonly cancelled = output<void>();
  protected readonly typed = signal('');
  /** The table itself is dropped (not rebuilt): its name is typed first. */
  protected readonly drops = computed(() => this.draft().dropping());
}
