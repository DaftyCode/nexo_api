import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { MongoExplorer } from './mongo-explorer';

/**
 * The side of the explorer: the databases and collections of the connection, its saved
 * queries, its query history and its latest writes.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-explorer-sidebar',
  styleUrl: './mongo-explorer.scss',
  styles: ':host { display: contents; }',
  templateUrl: './mongo-explorer-sidebar.html',
})
export class MongoExplorerSidebar {
  readonly explorer = input.required<MongoExplorer>();
}
