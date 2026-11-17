import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { quoteName } from '../domain/db/tree';
import { DbSection } from './db-panel/section';
import { StructureDraft, StructureRequest } from './db-panel/structure-draft';
import { DbStructureColumns } from './db-structure/columns';
import { DbStructureKeys } from './db-structure/keys';
import { DbDdlReview } from './db-structure/review';

/**
 * A table created, edited, dropped or emptied, as DBeaver's entity editor: its name, comment,
 * columns, keys and indexes; then the statements the driver wrote, read before they run.
 * Dropping and emptying ask for the table's name.
 */
@Component({
  imports: [TranslocoPipe, DbStructureColumns, DbStructureKeys, DbDdlReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-table-editor',
  template: `
    @let d = draft();
    <div class="db-structure-backdrop">
      <section
        class="feature-card db-structure-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-table-editor-title"
        (keydown.escape)="closed.emit()"
      >
        <h2 id="db-table-editor-title">{{ title() | transloco: { v0: request().name } }}</h2>
        @if (request().mode === 'empty') {
          <p>{{ 'db.structure.empty' | transloco }}</p>
          <label class="field"
            >{{ 'db.structure.typeName' | transloco: { v0: request().name }
            }}<input
              autocomplete="off"
              [value]="typed()"
              (input)="typed.set($any($event.target).value)"
          /></label>
        } @else if (request().mode !== 'drop') {
          <div class="row db-structure-head">
            <label class="field grow"
              >{{ 'Table name' | transloco
              }}<input
                autocomplete="off"
                [value]="d.table().name"
                (change)="rename($any($event.target).value)"
            /></label>
            <label class="field grow"
              >{{ 'Comment' | transloco
              }}<input
                [value]="d.table().comment ?? ''"
                (change)="comment($any($event.target).value)"
            /></label>
          </div>
          <nav class="editor-tabs" [attr.aria-label]="'Parts of the table' | transloco">
            @for (each of ['columns', 'keys']; track each) {
              <button
                type="button"
                [class.active]="tab() === each"
                [attr.aria-current]="tab() === each ? 'page' : null"
                (click)="tab.set($any(each))"
              >
                {{ (each === 'columns' ? 'Columns' : 'Keys and indexes') | transloco }}
              </button>
            }
          </nav>
          @if (tab() === 'columns') {
            <app-db-structure-columns [draft]="d" />
          } @else {
            <app-db-structure-keys [draft]="d" />
          }
        } @else {
          <p>{{ 'db.structure.drop' | transloco: { v0: request().name } }}</p>
          <label class="check-field"
            ><input
              type="checkbox"
              [checked]="cascade()"
              (change)="cascade.set($any($event.target).checked)"
            />{{ 'Also what depends on it (cascade)' | transloco }}</label
          >
        }
        @if (d.error() && !d.plan()) {
          <p class="db-structure-error" role="alert">{{ d.error() | transloco }}</p>
        }
        <div class="row db-structure-actions">
          @if (request().mode === 'empty') {
            <button
              type="button"
              class="button primary danger"
              [disabled]="d.busy() || typed().trim() !== request().name"
              (click)="empty()"
            >
              {{ 'Empty' | transloco }}
            </button>
          } @else {
            <button
              type="button"
              class="button primary"
              [disabled]="d.busy() || (request().mode === 'edit' && !d.changed())"
              (click)="review()"
            >
              {{ (request().mode === 'drop' ? 'Show the DROP' : 'Show the changes') | transloco }}
            </button>
          }
          <button type="button" class="button" (click)="closed.emit()">
            {{ 'Cancel' | transloco }}
          </button>
        </div>
      </section>
    </div>
    <app-db-ddl-review
      [draft]="d"
      [name]="request().name"
      (ran)="run($event)"
      (script)="toScript($event)"
      (cancelled)="d.plan.set(undefined)"
    />
  `,
  styleUrl: './db-structure/dialog.scss',
})
export class DbTableEditor {
  readonly request = input.required<StructureRequest>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  protected readonly tab = signal<'columns' | 'keys'>('columns');
  protected readonly typed = signal('');
  protected readonly cascade = signal(false);
  protected readonly draft = computed(() => {
    const request = this.request();
    return untracked(() => {
      const draft = new StructureDraft(
        this.section,
        request.connection,
        request.path,
        request.mode === 'create',
      );
      void draft.load(request.mode === 'create' ? request.name : '');
      return draft;
    });
  });
  protected readonly title = computed(
    () =>
      ({
        create: 'New table',
        edit: 'db.structure.edit',
        drop: 'db.structure.dropTitle',
        empty: 'db.structure.emptyTitle',
      })[this.request().mode],
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.draft().close());
  }

  protected rename(name: string) {
    this.draft().table.update((table) => ({ ...table, name: name.trim() }));
  }
  protected comment(comment: string) {
    this.draft().table.update((table) => ({ ...table, comment: comment.trim() || undefined }));
  }
  protected review() {
    void this.draft().review(this.request().mode === 'drop', this.cascade());
  }
  protected async run(confirmName: string | undefined) {
    if (await this.draft().run(confirmName)) this.closed.emit();
  }
  protected async empty() {
    const { connection, name } = this.request();
    const table = this.draft().table();
    const style = this.section.quoteStyle(connection);
    const qualified = [table.schema, table.name || name]
      .filter(Boolean)
      .map((part) => quoteName(part!, style))
      .join('.');
    if (await this.draft().empty(qualified, name)) this.closed.emit();
  }
  /** «Save as script»: the statements in a new script, to run later. */
  protected toScript(script: string) {
    this.section.newScript(this.request().connection, { text: script });
    this.closed.emit();
  }
}
