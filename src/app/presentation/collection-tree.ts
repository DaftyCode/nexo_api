import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { StudioIcon } from './studio-icon';
import type { Workspace } from './workspace';

/** The collections of the sidebar as a tree, with their actions menus and dragging. */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-collection-tree',
  styles: ':host { display: contents; }',
  templateUrl: './collection-tree.html',
})
export class CollectionTree {
  readonly workspace = input.required<Workspace>();
}
