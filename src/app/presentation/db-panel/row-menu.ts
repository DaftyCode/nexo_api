import { TranslocoPipe } from '@jsverse/transloco';
import { TEMPLATE_FOLDERS } from '../../domain/db/ddl-templates';
import { editsStructure } from './structure-request';
import { takesTestData } from './mock-request';
import { administers } from './admin';
import { engineProfile } from '../../domain/db/engines';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NavigatorRow } from '../../domain/db/rows';
import { NATIVE_FILES } from '../../composition/providers';
import { readDbConnection } from '../../domain/db/connection';
import { hasNativeTools } from '../../domain/db/native';
import { menuKeys } from '../menu-keys';
import { MenuAction } from './menu';
import { DbSection } from './section';

/**
 * The actions menu of a row of the navigator, at the mouse or under the row: what a
 * connection, a node, a folder or a script allows. A WAI-ARIA menu for the keyboard.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-row-menu',
  templateUrl: './row-menu.html',
})
export class DbRowMenu {
  readonly row = input.required<NavigatorRow>();
  readonly x = input(0);
  readonly y = input<number | undefined>(undefined);
  /** Opened over the row: the distance from the window's foot to the menu's bottom. */
  readonly bottom = input<number | undefined>(undefined);
  /** The tallest it may be to stay in the window. */
  readonly maxHeight = input<number | undefined>(undefined);
  readonly chosen = output<MenuAction>();
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  /** «Generate SQL» of a table or view, as DBeaver's. */
  protected readonly generated = [
    ['generateSelect', 'SELECT'],
    ['generateInsert', 'INSERT'],
    ['generateUpdate', 'UPDATE'],
    ['generateDelete', 'DELETE'],
    ['generateMerge', 'MERGE'],
  ] as const;
  /** A folder whose new objects start from a template of their engine (DB-19). */
  protected readonly templated = computed(() =>
    (TEMPLATE_FOLDERS as readonly string[]).includes(this.row().node?.name ?? ''),
  );
  /** A row of a MongoDB connection, which has its own short menu (DB-39). */
  protected readonly mongo = computed(() => {
    const row = this.row();
    return row.type !== 'folder' && !!this.section.mongo.connection(row.connection ?? '');
  });
  /** The sessions and locks of the server of a connection (DB-21), when its driver lists them. */
  protected readonly admin = computed(() => administers(this.section, this.row().connection));
  /** The local client tools of its engine, in the desktop app (DB-23). */
  protected readonly native = computed(() => {
    const document = this.section.connection(this.row().connection ?? '');
    return (
      this.nativeFiles.available &&
      !!document &&
      hasNativeTools(readDbConnection(document.value).driver)
    );
  });
  private readonly nativeFiles = inject(NATIVE_FILES);
  /** An engine with an HTTP API has its console of requests (DB-36). */
  protected readonly rest = computed(() => {
    const document = this.section.connection(this.row().connection ?? '');
    return !!document && !!engineProfile(readDbConnection(document.value).driver).rest;
  });
  /** A SQLite file, a schema, a database or a table can be compared with another (DB-24). */
  protected readonly compares = computed(() => {
    const row = this.row();
    if (row.type === 'node') return ['schema', 'database', 'table'].includes(row.node?.kind ?? '');
    const document = this.section.connection(row.connection ?? '');
    return (
      row.type === 'connection' &&
      !!document &&
      readDbConnection(document.value).driver === 'sqlite'
    );
  });
  /** Tables, schemas, databases and folders of tables have a diagram (DB-20). */
  protected readonly diagrammed = computed(() => {
    const node = this.row().node;
    return (
      ['table', 'schema', 'database'].includes(node?.kind ?? '') ||
      (node?.kind === 'folder' && node.name === 'tables')
    );
  });
  /** The structure of a table (DB-19), when its driver edits it. */
  protected readonly structure = computed(() =>
    editsStructure(this.section, this.row().connection),
  );
  /** Test data, where the connection takes it (DB-27). */
  protected readonly takesTestData = computed(() =>
    takesTestData(this.section, this.row().connection),
  );
  protected readonly tableStructure = [
    ['editStructure', 'Edit structure…'],
    ['emptyTable', 'Empty table…'],
    ['dropTable', 'Drop table…'],
  ] as const;
  /** Data in and out of a table (DB-17). */
  protected readonly transfers = [
    ['exportData', 'Export data…'],
    ['importData', 'Import data…'],
    ['copyData', 'Copy to another connection…'],
  ] as const;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => {
      this.host.querySelector<HTMLElement>('button')?.focus();
      // What the driver can do decides some entries: it is asked once, connected or not.
      const connection = this.row().type === 'connection' ? this.row().connection : undefined;
      if (connection) void this.section.drivers.learn(connection).catch(() => undefined);
    });
  }

  protected key(event: KeyboardEvent) {
    menuKeys(event, this.host, () => this.closed.emit());
  }
}
