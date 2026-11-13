import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { Splitter } from './splitter';
import { CollectionTree } from './collection-tree';
import { StudioIcon } from './studio-icon';
import type { Workspace } from './workspace';
import { ListDrag, dropIndex } from './workspace/list-drag';

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
  /** The sections of the side menu, dragged to another place. */
  readonly sectionDrag = new ListDrag('auto', (id, over, side) => {
    const appearance = this.workspace().appearance;
    const ids = appearance.sections().map((section) => section.id);
    appearance.moveSection(id, dropIndex(ids, over, side));
  });

  /** Alt+↑ and Alt+↓ (or ← and →) move the focused section, as dragging it does. */
  protected moveSection(event: KeyboardEvent, id: string) {
    const offset = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
    if (!event.altKey || !offset) return;
    event.preventDefault();
    const appearance = this.workspace().appearance;
    const index = appearance.sections().findIndex((section) => section.id === id);
    if (index + offset < 0) return;
    appearance.moveSection(id, offset < 0 ? index - 1 : index + 2);
    const button = event.currentTarget as HTMLElement;
    // The button is moved in the page: keep the focus on it.
    queueMicrotask(() => button.focus());
  }
}
