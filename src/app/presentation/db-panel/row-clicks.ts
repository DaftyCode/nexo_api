import type { NavigatorRow } from '../../domain/db/rows';
import type { DbActions } from './actions';
import type { DbSection } from './section';

/** How long a click on a table or a view waits for a second one, which opens its tab. */
export const DOUBLE_CLICK_MS = 300;

/** Tables and views: what a double click opens in a tab, on its data. */
function opensTab(row: NavigatorRow) {
  return row.type === 'node' && !!row.node?.actions.includes('data');
}

/**
 * What the mouse and Enter do on a row of the navigator. A click opens or closes a row. A
 * double click, or Enter, opens the tab of a table or a view; on one whose tab is open it
 * opens or closes the row instead; any other row it opens or closes, or opens what it is (a
 * function, a script). As the two clicks of a double click would open and close a table first,
 * a click on one waits a moment to know whether a second one follows.
 */
export class RowClicks {
  private waiting?: { key: string; timer?: ReturnType<typeof setTimeout> };

  constructor(
    private readonly section: DbSection,
    private readonly actions: DbActions,
  ) {}

  /** A click; `count` is the click's number in a series, as `MouseEvent.detail` says. */
  click(row: NavigatorRow, onArrow: boolean, count: number) {
    // The second click of a double click: the double click decides.
    if (!row.expandable || count > 1) return;
    if (onArrow || !opensTab(row)) return void this.actions.toggle(row);
    const waiting: { key: string; timer?: ReturnType<typeof setTimeout> } = { key: row.key };
    waiting.timer = setTimeout(() => {
      waiting.timer = undefined;
      void this.actions.toggle(row);
    }, DOUBLE_CLICK_MS);
    this.waiting = waiting;
  }

  /** A double click: its first click opened or closed the row, unless it is still waiting. */
  double(row: NavigatorRow) {
    const pending = this.waiting?.key === row.key && !!this.waiting.timer;
    if (pending) this.stop();
    this.activate(row, !pending);
  }

  /** Enter, or a double click; `toggled` when its first click already opened or closed it. */
  activate(row: NavigatorRow, toggled = false) {
    if (opensTab(row)) {
      const shown = !!this.section.tabs.find({
        kind: 'object',
        connection: row.connection ?? '',
        title: row.label,
        path: row.path ?? [],
      });
      this.actions.open(row);
      if (shown && !toggled) void this.actions.toggle(row);
    } else if (!row.expandable) this.actions.open(row);
    else if (!toggled) void this.actions.toggle(row);
  }

  /** Forgets a click that waits, as the navigator goes away or a double click arrives. */
  stop() {
    clearTimeout(this.waiting?.timer);
    this.waiting = undefined;
  }
}
