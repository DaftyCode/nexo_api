import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import type { KvChange } from '../application/database-use-cases';
import { KV_TYPES } from '../domain/db/keyvalue';
import type { KeysRun } from './db-panel/keys-run';

/**
 * A new key (DB-35): its name, its type and its first value (a hash's first field, a sorted
 * set's first member with its score, a stream's first entry). An existing key is never
 * overwritten.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-new-key',
  template: `
    <form class="kv-new" (submit)="$event.preventDefault(); create()">
      <h2>{{ 'New key' | transloco }}</h2>
      <label>
        <span>{{ 'Name' | transloco }}</span>
        <input [formField]="fields.key" placeholder="user:1" />
      </label>
      <label>
        <span>{{ 'Type' | transloco }}</span>
        <select [formField]="fields.type">
          @for (type of types; track type) {
            <option [value]="type">{{ type }}</option>
          }
        </select>
      </label>
      @if (model().type === 'hash') {
        <label>
          <span>{{ 'Field' | transloco }}</span>
          <input [formField]="fields.field" />
        </label>
      }
      <label>
        <span>{{ (model().type === 'stream' ? 'Fields' : 'Value') | transloco }}</span>
        <input
          [formField]="fields.value"
          [placeholder]="model().type === 'stream' ? '{&quot;field&quot;: &quot;value&quot;}' : ''"
        />
      </label>
      @if (model().type === 'zset') {
        <label>
          <span>{{ 'Score' | transloco }}</span>
          <input [formField]="fields.score" inputmode="decimal" />
        </label>
      }
      <div class="kv-new-actions">
        <button type="submit" class="button primary small">{{ 'Create' | transloco }}</button>
        <button type="button" class="button small" (click)="done.emit()">
          {{ 'Cancel' | transloco }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .kv-new {
      display: grid;
      gap: var(--nexo-space-3);
    }
    h2 {
      margin: 0;
    }
    label {
      display: grid;
      gap: var(--nexo-space-1);
    }
    .kv-new-actions {
      display: flex;
      gap: var(--nexo-space-2);
    }
  `,
})
export class DbNewKey {
  readonly run = input.required<KeysRun>();
  readonly done = output<void>();
  protected readonly types = KV_TYPES;
  protected readonly model = signal({ key: '', type: 'string', field: '', value: '', score: '0' });
  protected readonly fields = form(this.model, (path) => required(path.key));

  protected async create() {
    const m = this.model();
    if (!m.key.trim()) return;
    const change: KvChange = { key: m.key.trim(), action: 'set', type: m.type, value: m.value };
    if (m.type === 'hash') change.field = m.field;
    if (m.type === 'zset') change.score = Number(m.score) || 0;
    if (m.type === 'stream') {
      try {
        const fields = JSON.parse(m.value) as Record<string, unknown>;
        change.fields = Object.entries(fields).map(([field, value]) => [field, String(value)]);
      } catch {
        this.run().error.set('db.kv.streamFields');
        return;
      }
      delete change.value;
    }
    if (await this.run().write(change)) this.done.emit();
  }
}
