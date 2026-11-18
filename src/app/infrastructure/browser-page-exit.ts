import { Injectable, inject } from '@angular/core';
import type { ExecuteArgs, PageExitPort } from '../application/ports';
import { HttpApi } from './http-api';

/**
 * The page going, as the browser tells it (`pagehide`: the tab or the window closes, the
 * page reloads or goes elsewhere), and what is sent then: requests the browser completes
 * after the page is gone. A page the browser kept in its back-forward cache comes back
 * without what it closed, so it starts again.
 */
@Injectable()
export class BrowserPageExit implements PageExitPort {
  private readonly api = inject(HttpApi);

  onExit(leave: () => boolean) {
    let closed = false;
    globalThis.addEventListener?.('pagehide', () => {
      closed = leave() || closed;
    });
    globalThis.addEventListener?.('pageshow', (event) => {
      if (!(event as PageTransitionEvent).persisted || !closed) return;
      closed = false;
      this.restart();
    });
  }
  protected restart() {
    globalThis.location.reload();
  }
  send(...args: ExecuteArgs) {
    this.api.executeOnExit(...args);
  }
}
