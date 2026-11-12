import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { Splitter } from './splitter';
import { CollectionTree } from './collection-tree';
import { StudioIcon } from './studio-icon';
import type { Workspace } from './workspace';

/**
 * The navigation of the workspace: the rail of sections and the sidebar with the collection
 * tree, environments and history.
 */
@Component({
  imports: [TranslocoPipe, DatePipe, Splitter, StudioIcon, CollectionTree],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace-navigation',
  styles: ':host { display: contents; }',
  templateUrl: './workspace-navigation.html',
})
export class WorkspaceNavigation {
  readonly workspace = input.required<Workspace>();
  /** The search of the collections, which Ctrl+K focuses. */
  readonly collectionSearch = viewChild<ElementRef<HTMLInputElement>>('collectionSearch');
}
