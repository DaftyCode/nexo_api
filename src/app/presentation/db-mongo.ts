import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DbTab } from '../domain/db/session';
import { WorkspaceDocument } from '../domain/models';
import { DbSection } from './db-panel/section';
import { ExplorerFocus, MongoExplorer } from './mongo-explorer';
import { MongoPanel } from './mongo-panel';

/**
 * The tab of a MongoDB connection in the databases section (DB-39): its explorer, with the
 * views of a collection (documents, aggregations, SQL, schema, indexes, explain, profiler)
 * and its shell, on what the navigator opened.
 */
@Component({
  imports: [MongoExplorer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-mongo',
  template: `@if (document(); as connection) {
    <app-mongo-explorer
      [connection]="connection"
      [focus]="focus()"
      (closed)="section.edit(connection)"
    />
  }`,
})
export class DbMongoTab {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly document = computed(() =>
    this.section.mongo.connection(this.tab().connection),
  );
  /** A new object each time the navigator opens the tab, so the explorer follows it. */
  protected readonly focus = computed<ExplorerFocus>(() => {
    const tab = this.tab();
    return { path: tab.path, shell: tab.part === 'shell' };
  });
}

/** The tab of a MongoDB connection's form, new or saved, in the databases section. */
@Component({
  imports: [MongoPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-mongo-editor',
  template: `<app-mongo-panel
    [connectionId]="tab().connection"
    (saved)="saved($event)"
    (removed)="section.closeTab(tab().id)"
    (explore)="section.mongo.open($event.id)"
  />`,
})
export class DbMongoEditor {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);

  /** The tab now edits the saved connection, which the navigator shows chosen. */
  protected saved(connection: WorkspaceDocument) {
    this.section.tabs.update(this.tab().id, { connection: connection.id, title: connection.name });
    this.section.active.set(connection.id);
  }
}
