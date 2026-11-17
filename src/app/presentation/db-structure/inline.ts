import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  untracked,
} from '@angular/core';
import { DbSection } from '../db-panel/section';
import { StructureDraft } from '../db-panel/structure-draft';
import type { DbTab } from '../db-panel/tabs-store';
import { DbStructureColumns } from './columns';
import { DbDdlReview } from './review';

/**
 * The «Columns» view of a table, edited in place (asked for by the owner, as DBeaver's):
 * every cell with its editor, the changed ones marked, «Save» showing the `ALTER` the driver
 * wrote before it runs, and «Revert».
 */
@Component({
  imports: [TranslocoPipe, DbStructureColumns, DbDdlReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-structure-inline',
  template: `
    @let d = draft();
    <div class="row db-structure-actions" role="toolbar" [attr.aria-label]="'Columns' | transloco">
      @if (d.changed()) {
        <span class="muted grow">{{ 'db.structure.pending' | transloco }}</span>
      }
      <button
        type="button"
        class="button small primary"
        [disabled]="d.busy() || !d.changed()"
        (click)="d.review()"
      >
        {{ 'Save' | transloco }}
      </button>
      <button type="button" class="button small" [disabled]="!d.changed()" (click)="d.revert()">
        {{ 'Revert' | transloco }}
      </button>
    </div>
    @if (d.error() && !d.plan()) {
      <p class="db-structure-error" role="alert">{{ d.error() | transloco }}</p>
    }
    @if (d.original()) {
      <app-db-structure-columns [draft]="d" />
    } @else if (d.busy()) {
      <div class="spinner" role="status" [attr.aria-label]="'Loading' | transloco"></div>
    }
    <app-db-ddl-review
      [draft]="d"
      (ran)="run()"
      (script)="toScript($event)"
      (cancelled)="d.plan.set(undefined)"
    />
  `,
  styleUrl: './structure.scss',
})
export class DbStructureInline {
  readonly tab = input.required<DbTab>();
  private readonly section = inject(DbSection);
  protected readonly draft = computed(() => {
    const tab = this.tab();
    return untracked(() => {
      const draft = new StructureDraft(this.section, tab.connection, tab.path ?? [], false);
      void draft.load();
      return draft;
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.draft().close());
  }

  protected async run() {
    if (await this.draft().run()) await this.draft().load();
  }
  protected toScript(script: string) {
    this.section.newScript(this.tab().connection, { text: script });
    this.draft().plan.set(undefined);
  }
}
