import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WorkspaceState } from './workspace-state';
import { ListDrag, dropIndex } from './workspace/list-drag';

/** The open requests as tabs, dragged to put them in another order, as in Postman. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-request-tabbar',
  styles: ':host { display: contents; }',
  templateUrl: './request-tabbar.html',
})
export class RequestTabbar {
  readonly state = inject(WorkspaceState);
  readonly drag = new ListDrag('x', (id, over, side) => {
    const ids = this.state.tabs().map((tab) => tab.id);
    this.state.moveTab(id, dropIndex(ids, over, side));
  });
}
