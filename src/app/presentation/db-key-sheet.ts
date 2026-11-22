import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { KvChange } from '../application/database-use-cases';
import { KvElement, isBinary, kvText, parseTtl, ttlText } from '../domain/db/keyvalue';
import type { KeysRun } from './db-panel/keys-run';

/** What the element form holds: a hash's field, a value, a sorted set's score. */
const EMPTY = { value: '', field: '', score: '', ttl: '', to: '' };

/**
 * The sheet of a key (DB-35): its type, expiry (set or removed), size and encoding, renaming
 * and deleting it, and its value with the editor of its type. A binary value is shown with
 * its bytes escaped and never rewritten from that text.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-key-sheet',
  templateUrl: './db-key-sheet.html',
  styleUrl: './db-keys-sheet.scss',
})
export class DbKeySheet {
  readonly run = input.required<KeysRun>();
  protected readonly value = computed(() => this.run().selected()!);
  protected readonly text = kvText;
  protected readonly ttl = ttlText;
  protected readonly binary = computed(() => isBinary(this.value().value));
  protected readonly model = signal({ ...EMPTY });
  protected readonly fields = form(this.model);
  /** The element being changed, whose form the person fills. */
  protected readonly editing = signal<KvElement | undefined>(undefined);
  protected readonly invalidTtl = signal(false);

  constructor() {
    // Another key: its value in the form, nothing being changed.
    effect(() => {
      const value = this.value();
      untracked(() => {
        this.editing.set(undefined);
        const text = typeof value.value === 'string' ? value.value : '';
        this.model.set({ ...EMPTY, value: text, to: kvText(value.key) });
      });
    });
  }

  private change(change: Omit<KvChange, 'key'>) {
    return this.run().write({ key: this.value().key, ...change });
  }

  protected setTtl() {
    const ms = parseTtl(this.model().ttl);
    this.invalidTtl.set(ms === undefined);
    if (ms !== undefined) void this.change({ action: 'expire', ttlMs: ms });
  }
  protected persist() {
    void this.change({ action: 'expire' });
  }
  protected rename() {
    const to = this.model().to.trim();
    if (to && to !== kvText(this.value().key)) void this.change({ action: 'rename', to });
  }
  protected remove() {
    void this.change({ action: 'delete' });
  }
  protected save() {
    void this.change({ action: 'set', value: this.model().value });
  }
  /** Lays out a JSON text, when it is one. */
  protected format() {
    try {
      const pretty = JSON.stringify(JSON.parse(this.model().value), null, 2);
      this.model.update((model) => ({ ...model, value: pretty }));
    } catch {
      // Not JSON: left as it is.
    }
  }
  protected json = computed(() => {
    try {
      JSON.parse(this.model().value);
      return true;
    } catch {
      return false;
    }
  });

  /** Puts an element in the form to change it. */
  protected edit(element: KvElement) {
    this.editing.set(element);
    this.model.update((model) => ({
      ...model,
      value: kvText(element.value),
      field: kvText(element.field),
      score: element.score === undefined ? '' : String(element.score),
    }));
  }
  protected cancel() {
    this.editing.set(undefined);
    this.model.update((model) => ({ ...model, value: '', field: '', score: '' }));
  }

  /** Adds the element of the form, or changes the one being edited. */
  protected async put() {
    const type = this.value().type;
    const model = this.model();
    const old = this.editing();
    const change: Omit<KvChange, 'key'> = { action: 'put', value: model.value };
    if (type === 'hash') change.field = model.field;
    if (type === 'zset') change.score = Number(model.score) || 0;
    if (type === 'list' && old) change.index = old.index;
    if ((type === 'set' || type === 'zset') && old) change.field = old.value;
    if (type === 'stream') {
      let object: Record<string, unknown>;
      try {
        object = JSON.parse(model.value) as Record<string, unknown>;
      } catch {
        this.run().error.set('db.kv.streamFields');
        return;
      }
      change.fields = Object.entries(object).map(([field, value]) => [field, String(value)]);
      delete change.value;
    }
    if (await this.change(change)) this.cancel();
  }

  protected drop(element: KvElement) {
    const type = this.value().type;
    if (type === 'hash') void this.change({ action: 'remove', field: element.field });
    else if (type === 'stream') void this.change({ action: 'remove', field: element.id });
    else void this.change({ action: 'remove', value: element.value });
  }
}
