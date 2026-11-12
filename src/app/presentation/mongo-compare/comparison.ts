import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import type {
  CompareResult,
  CompareRules,
  CompareSide,
  DifferenceKind,
  SyncResult,
} from '../../application/mongo-use-cases';
import { connectionValue } from '../../domain/mongo';
import { CompareValue, fieldList } from '../../domain/mongo-compare';
import { shellToExtendedJson } from '../../domain/mongo-query';
import { resolveVariables } from '../../domain/variables';
import type { MongoExplorer } from '../mongo-explorer';

/** What the comparison dialog edits. */
export interface CompareModel {
  connection: string;
  database: string;
  collection: string;
  filter: string;
  key: string;
  ignore: string;
  remove: boolean;
  confirm: string;
  name: string;
}

/**
 * A comparison of the collection shown with another one: its settings, its result filtered
 * by kind with the fields of the difference chosen, and the sync of the target.
 */
export class Comparison {
  readonly model;
  readonly fields;
  readonly phase = signal<'setup' | 'running' | 'done'>('setup');
  readonly result = signal<CompareResult | undefined>(undefined);
  readonly shown = signal<DifferenceKind | 'all'>('all');
  readonly chosen = signal(-1);
  readonly synced = signal<SyncResult | undefined>(undefined);
  readonly error = signal('');
  /** The query running, to cancel it. */
  running = '';
  readonly differences = computed(() => {
    const shown = this.shown();
    return (this.result()?.differences ?? []).filter((d) => shown === 'all' || d.kind === shown);
  });
  /** The target may be written: its saved connection is not read-only. */
  readonly writable = computed(() => {
    const target = this.connections().find((d) => d.id === this.model().connection);
    return !!target && !connectionValue(target.value).readOnly;
  });

  constructor(
    private readonly explorer: MongoExplorer,
    injector: Injector,
    stored: CompareValue,
    name = '',
  ) {
    this.model = signal<CompareModel>({
      connection: stored.target.connection,
      database: stored.target.database,
      collection: stored.target.collection,
      filter: stored.filter,
      key: stored.key,
      ignore: stored.ignore.join(', '),
      remove: stored.remove,
      confirm: '',
      name,
    });
    this.fields = runInInjectionContext(injector, () => form(this.model));
  }

  connections() {
    return this.explorer.state.documents().filter((d) => d.kind === 'connection');
  }
  /** The source: the collection shown. */
  source(): CompareSide | undefined {
    const target = this.explorer.target();
    if (!target) return undefined;
    return {
      connection: this.explorer.connection(),
      database: target.database,
      collection: target.collection,
    };
  }
  target(): CompareSide | undefined {
    const m = this.model();
    const connection = this.connections().find((d) => d.id === m.connection);
    if (!connection || !m.database.trim() || !m.collection.trim()) return undefined;
    return { connection, database: m.database.trim(), collection: m.collection.trim() };
  }
  /** The rules typed, or why the filter cannot be read. */
  rules(): CompareRules {
    const m = this.model();
    const scopes = this.explorer.state.scopes();
    const text = resolveVariables(m.filter, scopes).trim();
    const filter = text ? (shellToExtendedJson(text) as Record<string, unknown>) : undefined;
    return {
      ...(filter ? { filter } : {}),
      key: m.key.trim() || '_id',
      ignore: fieldList(m.ignore),
    };
  }
  /** The comparison as it is saved. */
  value(): CompareValue {
    const m = this.model();
    const source = this.source();
    return {
      connection: this.explorer.connection().id,
      database: source?.database ?? '',
      collection: source?.collection ?? '',
      target: {
        connection: m.connection,
        database: m.database.trim(),
        collection: m.collection.trim(),
      },
      filter: m.filter,
      key: m.key.trim() || '_id',
      ignore: fieldList(m.ignore),
      remove: m.remove,
    };
  }
}
