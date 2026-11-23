import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { SharedState } from './shared-state';
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
  /** The collections shared by the team, with what waits for the person (C-01). */
  protected readonly shared = inject(SharedState);
}
