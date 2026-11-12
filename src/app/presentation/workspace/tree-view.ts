import { signal } from '@angular/core';
import { CollectionItem, WorkspaceDocument, asCollection } from '../../domain/models';
import { DropPosition, dropPlace, folders, isWithin } from '../../domain/collection-tree';
import { WorkspaceState } from '../workspace-state';

/** The collection tree of the sidebar: folders folded, items dragged and moved. */
export class CollectionTreeView {
  readonly collapsed = signal<string[]>([]);
  /** The item being dragged in the tree. */
  private readonly dragging = signal<{ collection: string; path: number[] } | undefined>(undefined);
  /** Where the dragged item would land, to draw it; `invalid` for a folder into itself. */
  readonly dropHint = signal<
    { collection: string; key: string; position: DropPosition; invalid: boolean } | undefined
  >(undefined);

  constructor(private readonly state: WorkspaceState) {}

  /** Collapsed state key of a folder, next to the ids of collapsed collections. */
  folderKey(collection: string, path: readonly number[]) {
    return `${collection}/${path.join('.')}`;
  }
  /** Items of a collection shown in the tree: those inside a collapsed folder are hidden. */
  visibleEntries(collection: string) {
    const collapsed = this.collapsed();
    return (this.state.trees().get(collection) ?? []).filter(
      (entry) =>
        !entry.path
          .slice(0, -1)
          .some((_, index) =>
            collapsed.includes(this.folderKey(collection, entry.path.slice(0, index + 1))),
          ),
    );
  }
  toggle(id: string) {
    this.collapsed.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  }
  dragStart(event: DragEvent, collection: WorkspaceDocument, path: number[], name: string) {
    this.dragging.set({ collection: collection.id, path });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox only starts a drag with some data.
      event.dataTransfer.setData('text/plain', name);
    }
  }
  /** Before or after a request; before, inside or after a folder, by where the pointer is. */
  private position(event: DragEvent, folder: boolean): DropPosition {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(box.height, 1);
    if (!folder) return ratio < 0.5 ? 'before' : 'after';
    return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
  }
  /** Only within the collection the item comes from. `path` `[]` is the collection itself. */
  dragOver(event: DragEvent, collection: WorkspaceDocument, path: number[], folder: boolean) {
    const dragged = this.dragging();
    if (!dragged || dragged.collection !== collection.id) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropHint.set({
      collection: collection.id,
      key: path.join('.'),
      position,
      invalid: isWithin(dropPlace(path, position).folder, dragged.path),
    });
  }
  /** The hint of a row: where the item would land next to it, if anywhere. */
  hint(collection: string, path: number[]) {
    const hint = this.dropHint();
    return hint?.collection === collection && hint.key === path.join('.') ? hint : undefined;
  }
  drop(event: DragEvent, collection: WorkspaceDocument, path: number[], folder: boolean) {
    const dragged = this.dragging();
    this.dragEnd();
    if (!dragged || dragged.collection !== collection.id) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    // A folder that receives an item opens, so the item stays in sight.
    if (position === 'inside' && path.length)
      this.collapsed.update((list) =>
        list.filter((key) => key !== this.folderKey(collection.id, path)),
      );
    void this.state.dropItem(collection, dragged.path, path, position);
  }
  dragEnd() {
    this.dragging.set(undefined);
    this.dropHint.set(undefined);
  }
  method(item: CollectionItem) {
    return typeof item.request === 'object' ? String(item.request['method'] ?? 'GET') : 'GET';
  }
  folderChoices(document: WorkspaceDocument, path: number[]) {
    const all = folders(asCollection(document.value));
    // A folder cannot move into itself or one of its own folders.
    return all.filter(
      (folder) =>
        !(folder.path.length >= path.length && path.every((index, i) => folder.path[i] === index)),
    );
  }
  moveTo(document: WorkspaceDocument, path: number[], event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    if (value === '') return;
    void this.state.moveItem(document, path, value === 'root' ? [] : value.split('.').map(Number));
  }
}
