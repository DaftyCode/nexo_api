import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DbConnectionEditor } from './db-connection-editor';
import { DbNavigator } from './db-navigator';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { ModuleDownload } from './module-download';
import { Splitter } from './splitter';

/** The narrowest and widest the navigator gets, in pixels. */
const NAVIGATOR = { min: 200, initial: 300 };

/**
 * The database section, laid out as DBeaver: the navigator of connections on the left, and
 * the editors of what is opened in it in tabs on the right. Connections of every database
 * module live here; their drivers are downloaded the first time they are used.
 */
@Component({
  imports: [TranslocoPipe, DbNavigator, DbConnectionEditor, ModuleDownload, Splitter],
  providers: [DbSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-panel',
  styleUrl: './db-panel.scss',
  templateUrl: './db-panel.html',
})
export class DbPanel {
  protected readonly section = inject(DbSection);
  protected readonly tabs = this.section.tabs;
  protected readonly width = signal(NAVIGATOR.initial);
  protected readonly folded = signal(false);

  protected resize(width: number) {
    this.width.set(Math.max(NAVIGATOR.min, width));
  }

  protected production(tab: DbTab) {
    return !!tab.connection && this.section.typeOf(tab.connection) === 'production';
  }

  /** Arrows move between tabs, as in a WAI-ARIA tab list. */
  protected tabKey(event: KeyboardEvent, tab: DbTab) {
    const tabs = this.tabs.tabs();
    const index = tabs.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : undefined;
    if (!next) return;
    event.preventDefault();
    this.tabs.activeId.set(next.id);
    const list = (event.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus());
  }
}
