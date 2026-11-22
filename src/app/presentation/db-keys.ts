import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { DbTab } from '../domain/db/session';
import { KV_TYPES, KeyRow, sameKey, ttlText } from '../domain/db/keyvalue';
import { DbSection } from './db-panel/section';
import { DbKeySheet } from './db-key-sheet';
import { DbKeysConsole } from './db-keys-console';
import { DbKeysServer } from './db-keys-server';
import { DbNewKey } from './db-new-key';
import { StudioIcon } from './studio-icon';

/**
 * A database of Redis or Valkey (DB-35): its keys read by pages of SCAN and grouped by `:`,
 * filtered by a pattern and a type, the sheet of the key chosen, a console and the server's
 * view, on the tab's own session.
 */
@Component({
  imports: [
    TranslocoPipe,
    FormField,
    StudioIcon,
    DbKeySheet,
    DbKeysConsole,
    DbKeysServer,
    DbNewKey,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-keys',
  templateUrl: './db-keys.html',
  styleUrl: './db-keys.scss',
})
export class DbKeys {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly run = computed(() => this.section.editors.keys(this.tab().id));
  protected readonly view = signal<'keys' | 'console' | 'server'>('keys');
  protected readonly creating = signal(false);
  protected readonly types = KV_TYPES;
  protected readonly ttl = ttlText;
  protected readonly filter = signal({ pattern: '', type: '' });
  protected readonly fields = form(this.filter);
  protected readonly confirmation = signal({ name: '' });
  protected readonly typed = form(this.confirmation);

  constructor() {
    effect(() => {
      const run = this.run();
      untracked(() => void run.start());
    });
  }

  protected search() {
    const run = this.run();
    run.pattern.set(this.filter().pattern);
    run.type.set(this.filter().type);
    void run.load();
  }

  protected choose(row: KeyRow) {
    if (row.key) {
      this.creating.set(false);
      void this.run().select(row.key.key);
    } else this.run().toggle(row.id);
  }
  protected chosen(row: KeyRow) {
    return !!row.key && sameKey(row.key.key, this.run().selected()?.key);
  }
  protected show(view: 'keys' | 'console' | 'server') {
    this.view.set(view);
    if (view === 'server') void this.run().console.server();
  }
  /** Runs the dangerous command that waits, with its name as typed. */
  protected confirm() {
    const waiting = this.run().console.waiting();
    if (!waiting) return;
    const name = this.confirmation().name;
    this.confirmation.set({ name: '' });
    void this.run().console.send(waiting.line, name);
  }
  protected newKey() {
    this.run().selected.set(undefined);
    this.creating.set(true);
  }
}
