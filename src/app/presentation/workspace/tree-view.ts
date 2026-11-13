import { signal } from '@angular/core';
import { CollectionItem, WorkspaceDocument, asCollection } from '../../domain/models';
import { DropPosition, dropPlace, folders, isWithin } from '../../domain/collection-tree';
import { WorkspaceState } from '../workspace-state';
import { ListDrag, dropIndex } from './list-drag';

/**
 * The collection tree of the sidebar: folders folded, items dragged and moved within their
 * collection or to another one, and collections dragged to put them in another order.
 */
export class CollectionTreeView {
  readonly collapsed = signal<string[]>([]);
  /** Collections dragged by their title, before or after another one. */
  readonly collectionDrag = new ListDrag('y', (id, over, side) =>
    this.state.moveCollection(id, dropIndex(this.collectionIds(), over, side)),
  );
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
  private collectionIds() {
    return this.state.collections().map((d) => d.id);
  }
  /** In its collection or another one, as in Postman. `path` `[]` is the collection itself. */
  dragOver(event: DragEvent, collection: WorkspaceDocument, path: number[], folder: boolean) {
    const dragged = this.dragging();
    if (!dragged) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropHint.set({
      collection: collection.id,
      key: path.join('.'),
      position,
      invalid:
        dragged.collection === collection.id &&
        isWithin(dropPlace(path, position).folder, dragged.path),
    });
  }
  /** The title of a collection takes a dragged collection beside it, or an item inside it. */
  titleOver(event: DragEvent, collection: WorkspaceDocument) {
    if (!this.collectionDrag.over(event, collection.id)) this.dragOver(event, collection, [], true);
  }
  titleLeave() {
    this.collectionDrag.hint.set(undefined);
    this.dropHint.set(undefined);
  }
  titleDrop(event: DragEvent, collection: WorkspaceDocument) {
    if (!this.collectionDrag.drop(event, collection.id)) this.drop(event, collection, [], true);
  }
  /** "Move up" and "Move down" of a collection, as dragging it one place. */
  shiftCollection(id: string, offset: -1 | 1) {
    const index = this.collectionIds().indexOf(id);
    if (index + offset < 0) return;
    this.state.moveCollection(id, offset < 0 ? index - 1 : index + 2);
  }
  /** The hint of a row: where the item would land next to it, if anywhere. */
  hint(collection: string, path: number[]) {
    const hint = this.dropHint();
    return hint?.collection === collection && hint.key === path.join('.') ? hint : undefined;
  }
  drop(event: DragEvent, collection: WorkspaceDocument, path: number[], folder: boolean) {
    const dragged = this.dragging();
    this.dragEnd();
    const source = this.state.collections().find((d) => d.id === dragged?.collection);
    if (!dragged || !source) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    // A folder that receives an item opens, so the item stays in sight.
    if (position === 'inside' && path.length)
      this.collapsed.update((list) =>
        list.filter((key) => key !== this.folderKey(collection.id, path)),
      );
    void this.state.dropItem(source, dragged.path, path, position, collection);
  }
  dragEnd() {
    this.dragging.set(undefined);
    this.dropHint.set(undefined);
  }
  method(item: CollectionItem) {
    return typeof item.request === 'object' ? String(item.request['method'] ?? 'GET') : 'GET';
  }
  /**
   * Where an item can be moved, by collection, its own first: the root and the folders. A
   * folder cannot move into itself or one of its own folders. Values are `collection id|path`.
   */
  moveTargets(document: WorkspaceDocument, path: number[]) {
    const all = this.state.collections();
    const own = all.filter((d) => d.id === document.id);
    return [...own, ...all.filter((d) => d.id !== document.id)].map((collection) => {
      let choices: { name: string; path: number[] }[] = [];
      try {
        choices = folders(asCollection(collection.value));
      } catch {
        // A collection that cannot be read only offers its root.
      }
      const own = collection.id === document.id;
      return {
        collection,
        folders: [{ name: collection.name, path: [] as number[] }, ...choices]
          .filter((folder) => !own || !isWithin(folder.path, path))
          .map((folder) => ({
            name: folder.name,
            value: `${collection.id}|${folder.path.join('.')}`,
          })),
      };
    });
  }
  moveTo(document: WorkspaceDocument, path: number[], event: Event) {
    const select = event.target as HTMLSelectElement;
    const [id, folder] = select.value.split('|');
    select.value = '';
    const target = this.state.collections().find((d) => d.id === id);
    if (!target) return;
    void this.state.moveItem(document, path, folder ? folder.split('.').map(Number) : [], target);
  }
}
