import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { EngineProfile } from '../domain/db/engines';
import { DbForm } from '../domain/db/form';

/**
 * The «Startup» tab of a database connection (DB-25): the default schema and the queries
 * every session runs as it opens, and how a connection is kept: a keep-alive query, closing
 * it sooner when unused, and how long it may take to open.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-connection-startup',
  styleUrl: './db-connection-editor.scss',
  template: `
    @if (profile().schemaStatement) {
      <label class="field"
        >{{ 'Default schema (several, with commas)' | transloco
        }}<input [formField]="fields().defaultSchema" spellcheck="false" autocomplete="off"
      /></label>
    }
    <p class="muted">
      {{ 'Queries every session runs as it opens, one statement each.' | transloco }}
    </p>
    @for (row of fields().startupQueries; track $index; let index = $index) {
      <div class="row db-param">
        <label class="field grow"
          >{{ 'db.startup.query' | transloco: { v0: index + 1 }
          }}<textarea [formField]="row.sql" rows="2" spellcheck="false"></textarea>
        </label>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'db.startup.remove' | transloco: { v0: index + 1 }"
          (click)="remove(index)"
        >
          ×
        </button>
      </div>
    }
    <button type="button" class="button small" (click)="add()">
      {{ '+ Add startup query' | transloco }}
    </button>
    @if (queries()) {
      <label class="check-field"
        ><input type="checkbox" [formField]="fields().ignoreStartupErrors" />{{
          'Open the session even if a startup query fails' | transloco
        }}</label
      >
    }
    @if (!profile().file) {
      <label class="field db-port"
        >{{ 'Keep alive every (seconds, 0 for never)' | transloco
        }}<input type="number" [formField]="fields().keepAliveSeconds"
      /></label>
      <label class="field db-port"
        >{{ 'Time to connect (seconds, 0 for the driver’s)' | transloco
        }}<input type="number" [formField]="fields().connectTimeoutSeconds"
      /></label>
    }
    <label class="field db-port"
      >{{ 'Close when unused for (minutes, 0 for ten)' | transloco
      }}<input type="number" [formField]="fields().idleMinutes"
    /></label>
    <p class="muted">
      {{
        'A session that closed opens again on its next use: what only reads runs again, what writes never does.'
          | transloco
      }}
    </p>
  `,
})
export class DbConnectionStartup {
  readonly fields = input.required<FieldTree<DbForm>>();
  readonly profile = input.required<EngineProfile>();
  protected readonly queries = computed(() => this.fields()().value().startupQueries.length > 0);

  protected add() {
    this.fields()().value.update((form) => ({
      ...form,
      startupQueries: [...form.startupQueries, { sql: '' }],
    }));
  }
  protected remove(index: number) {
    this.fields()().value.update((form) => ({
      ...form,
      startupQueries: form.startupQueries.filter((_, at) => at !== index),
    }));
  }
}
