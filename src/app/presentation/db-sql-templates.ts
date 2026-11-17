import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { SQL_TEMPLATES, SqlTemplate } from '../domain/db/sql-templates';
import { DbSection } from './db-panel/section';

const EMPTY: SqlTemplate = { name: '', description: '', text: '' };

/**
 * The «Templates» panel of a SQL tab, as DBeaver's: the editor's templates and the person's
 * own, each an abbreviation that Tab turns into its text. Their own are kept on this computer;
 * one with the name of an editor's template takes its place.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sql-templates',
  template: `
    <aside class="db-side" [attr.aria-label]="'Templates' | transloco">
      <header class="row db-side-head">
        <h3>{{ 'Templates' | transloco }}</h3>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'Close' | transloco"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>
      <p class="muted">{{ 'db.templates.help' | transloco }}</p>
      <ul class="db-templates">
        @for (template of own(); track template.name) {
          <li class="row">
            <code class="grow">{{ template.name }}</code>
            <span class="grow muted">{{ template.description }}</span>
            <button
              type="button"
              class="icon-button"
              [attr.aria-label]="'db.templates.remove' | transloco: { v0: template.name }"
              (click)="remove(template.name)"
            >
              ×
            </button>
          </li>
        }
        @for (template of builtIn(); track template.name) {
          <li class="row">
            <code class="grow">{{ template.name }}</code>
            <span class="grow muted">{{ template.description | transloco }}</span>
          </li>
        }
      </ul>
      <form class="db-template-form" (submit)="$event.preventDefault(); add()">
        <h4>{{ 'New template' | transloco }}</h4>
        <label class="field"
          >{{ 'Abbreviation' | transloco }}<input [formField]="fields.name" autocomplete="off"
        /></label>
        <label class="field"
          >{{ 'Description' | transloco }}<input [formField]="fields.description"
        /></label>
        <label class="field"
          >{{ 'Text' | transloco
          }}<textarea rows="4" spellcheck="false" [formField]="fields.text"></textarea>
        </label>
        <button type="submit" class="button small" [disabled]="!valid()">
          {{ 'Add' | transloco }}
        </button>
      </form>
    </aside>
  `,
  styleUrl: './db-sql-side.scss',
})
export class DbSqlTemplates {
  readonly own = input.required<readonly SqlTemplate[]>();
  readonly changed = output<readonly SqlTemplate[]>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  /** The editor's templates the person's own have not replaced. */
  protected readonly builtIn = computed(() =>
    SQL_TEMPLATES.filter((template) => !this.own().some((own) => own.name === template.name)),
  );
  protected readonly draft = signal<SqlTemplate>({ ...EMPTY });
  protected readonly fields = form(this.draft);
  protected readonly valid = computed(
    () => /^[A-Za-z_]\w*$/.test(this.draft().name.trim()) && !!this.draft().text.trim(),
  );

  protected add() {
    if (!this.valid()) return;
    const name = this.draft().name.trim();
    const template = { ...this.draft(), name };
    this.save([...this.own().filter((own) => own.name !== name), template]);
    this.draft.set({ ...EMPTY });
  }
  protected remove(name: string) {
    this.save(this.own().filter((own) => own.name !== name));
  }
  private save(templates: readonly SqlTemplate[]) {
    void this.section.cases().then((cases) => cases.assist.setTemplates(templates));
    this.changed.emit(templates);
  }
}
