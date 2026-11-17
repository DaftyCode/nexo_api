import { signal } from '@angular/core';
import { NavigatorRow } from '../../domain/db/rows';
import { DbActions } from '../db-panel/actions';
import { TABLE_DRAG } from '../db-panel/diagrams';
import { DbSection } from '../db-panel/section';

/**
 * What is dragged from the navigator: a connection, to a folder or beside a connection of
 * another folder; and a table, to a saved diagram (DB-20).
 */
export class NavigatorDrag {
  /** The connection being dragged to a folder. */
  readonly dragging = signal('');
  readonly dropKey = signal('');

  constructor(
    private readonly section: DbSection,
    private readonly actions: DbActions,
  ) {}

  /** Whether a row can be dragged. */
  draggable(row: NavigatorRow) {
    return row.type === 'connection' || (row.type === 'node' && row.node?.kind === 'table');
  }

  start(event: DragEvent, row: NavigatorRow) {
    if (row.type === 'node' && row.node?.kind === 'table' && event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(
        TABLE_DRAG,
        JSON.stringify({ connection: row.connection, path: row.path }),
      );
      event.dataTransfer.setData('text/plain', row.label);
      return;
    }
    if (row.type !== 'connection' || !row.connection) return;
    this.dragging.set(row.connection);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.label);
    }
  }
  over(event: DragEvent, row: NavigatorRow) {
    if (!this.dragging() || (row.type !== 'folder' && row.type !== 'connection')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropKey.set(row.key);
  }
  drop(event: DragEvent, row: NavigatorRow) {
    const document = this.section.connection(this.dragging());
    this.end();
    if (!document || (row.type !== 'folder' && row.type !== 'connection')) return;
    event.preventDefault();
    void this.actions.task.announce('The connection could not be moved', () =>
      this.actions.move(document, row.folder ?? ''),
    );
  }
  end() {
    this.dragging.set('');
    this.dropKey.set('');
  }
}
