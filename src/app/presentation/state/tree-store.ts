import { WorkspaceDocument, asCollection } from '../../domain/models';
import {
  DropPosition,
  dropPlace,
  isWithin,
  itemAt,
  staysInPlace,
} from '../../domain/collection-tree';
import { VariableRow } from '../../domain/variables';
import { CollectionsStore } from './collections-store';
import { DocumentsStore } from './documents-store';
import { StateContext, named, success } from './state-context';

/**
 * Changes to the tree of a collection (folders, names, order and settings), each one said
 * in a toast with the name of the item it changed.
 */
export class TreeStore {
  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
    private readonly collections: CollectionsStore,
  ) {}

  /** Saves a change to the tree and says which item it changed, by its name after it. */
  private change(
    document: WorkspaceDocument,
    done: string,
    name: string,
    change: Parameters<CollectionsStore['change']>[1],
  ) {
    return this.context.status.announce('The collection could not be saved', async () => {
      await this.collections.change(document, change);
      return success(done, 'toast.itemIn', { v0: name, v1: document.name });
    });
  }
  addRequest(document: WorkspaceDocument, folderPath: number[] = []) {
    return this.context.status.announce('The collection could not be saved', async () => {
      await this.collections.addRequest(document, folderPath);
      return success('Request added', 'toast.itemIn', { v0: 'New request', v1: document.name });
    });
  }
  /** Saves the active request (Ctrl+S) and says in a toast whether, and where, it was saved. */
  saveActive(targetDocumentId?: string) {
    return this.context.status.announce('The request could not be saved', () =>
      this.collections.saveActive(targetDocumentId),
    );
  }
  /** The name of an item of a collection, as it is now. */
  itemName(document: WorkspaceDocument, path: readonly number[]) {
    try {
      return itemAt(asCollection(document.value), path)?.name ?? '';
    } catch {
      return '';
    }
  }
  addFolder(document: WorkspaceDocument, name: string, parent: number[] = []) {
    return this.change(document, 'Folder added', name.trim(), (tree, collection) =>
      tree.addFolder(collection, parent, name, this.context.cases.files.id()),
    );
  }
  renameItem(document: WorkspaceDocument, path: number[], name: string) {
    return this.change(document, 'Item renamed', name.trim(), (tree, collection) =>
      tree.renameItem(collection, path, name),
    );
  }
  async removeItem(document: WorkspaceDocument, path: number[]) {
    if (!this.context.confirm('Delete this item and everything inside it?')) return false;
    return this.change(
      document,
      'Item deleted',
      this.itemName(document, path),
      (tree, collection) => tree.removeItem(collection, path),
    );
  }
  reorderItem(document: WorkspaceDocument, path: number[], offset: -1 | 1) {
    return this.change(document, 'Item moved', this.itemName(document, path), (tree, collection) =>
      tree.reorderItem(collection, path, offset),
    );
  }
  moveItem(document: WorkspaceDocument, path: number[], folder: number[]) {
    return this.change(document, 'Item moved', this.itemName(document, path), (tree, collection) =>
      tree.moveInto(collection, path, folder),
    );
  }
  /**
   * Moves an item dropped before, after or inside another one. A folder dropped into itself
   * stays and the reason is announced; so is the move.
   */
  async dropItem(
    document: WorkspaceDocument,
    path: number[],
    over: number[],
    position: DropPosition,
  ) {
    const { folder, index } = dropPlace(over, position);
    if (isWithin(folder, path)) {
      this.context.status.tell({ kind: 'info', title: 'A folder cannot be moved into itself' });
      return false;
    }
    if (staysInPlace(path, folder, index)) return true;
    return this.change(document, 'Item moved', this.itemName(document, path), (tree, collection) =>
      tree.moveTo(collection, path, folder, index),
    );
  }
  /** Saves the variables, authorization and scripts of a collection or folder. */
  saveSettings(
    id: string,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
    folder: number[] = [],
  ) {
    const document = this.documents.collections().find((d) => d.id === id);
    return this.context.status.announce(
      folder.length ? 'The folder could not be saved' : 'The collection could not be saved',
      async () => {
        await this.documents.saveCollectionSettings(id, settings, folder);
        return folder.length && document
          ? success('Folder saved', 'toast.itemIn', {
              v0: this.itemName(document, folder),
              v1: document.name,
            })
          : named('Collection saved', document?.name ?? '');
      },
    );
  }
}
