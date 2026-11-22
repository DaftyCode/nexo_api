import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { DbSection } from './db-panel/section';
import { OBJECT_KINDS, SearchDraft } from './db-panel/search-draft';

type SearchTab = 'objects' | 'data' | 'scripts';

/**
 * The database search (Ctrl+H), as DBeaver's: objects by name (or in their code) in the
 * connections chosen, a value in the data of tables, and text in the saved scripts and the
 * history; each result opens what it found.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-search',
  templateUrl: './db-search.html',
  styleUrl: './db-search.scss',
})
export class DbSearch {
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  protected readonly draft = new SearchDraft(this.section, inject(Injector));
  protected readonly tab = signal<SearchTab>('objects');
  protected readonly tabs: readonly [SearchTab, string][] = [
    ['objects', 'Objects'],
    ['data', 'Data'],
    ['scripts', 'Scripts'],
  ];
  protected readonly kinds = OBJECT_KINDS;
  protected readonly production = computed(
    () => this.section.typeOf(this.draft.model().connection).rules.confirmWrites,
  );
  /** The data search reads whole tables: on production, only once the person agrees. */
  protected readonly canSearchData = computed(
    () =>
      !!this.draft.model().text.trim() &&
      this.draft.tables().some((table) => table.chosen) &&
      (!this.production() || this.draft.model().confirm),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      void this.draft.cancel();
      void this.draft.close();
    });
  }

  /** `schema.table.name`, without the parts it has not. */
  protected dotted(parts: readonly (string | undefined)[]) {
    return parts.filter(Boolean).join('.');
  }
  protected name(connection: string) {
    return this.section.connection(connection)?.name ?? connection;
  }
  protected search() {
    if (!this.draft.model().text.trim()) return;
    switch (this.tab()) {
      case 'objects':
        return void this.draft.findObjects();
      case 'data':
        return this.canSearchData() ? void this.draft.findData() : undefined;
      case 'scripts':
        return void this.draft.findScripts();
    }
  }
  protected chooseTable(at: number) {
    this.draft.tables.update((all) =>
      all.map((table, i) => (i === at ? { ...table, chosen: !table.chosen } : table)),
    );
  }
  protected useRecent(text: string) {
    this.draft.model.update((model) => ({ ...model, text }));
  }
  /** Opens a result and closes the dialog. */
  protected opened(open: () => void) {
    open();
    this.closed.emit();
  }
}
