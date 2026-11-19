import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { readEnvironmentSettings } from '../domain/environment-protection';
import { WorkspaceState } from './workspace-state';
import { ListDrag, dropIndex } from './workspace/list-drag';

/**
 * The open requests as tabs, dragged to put them in another order, as in Postman. They take
 * the colour of the active environment, as Studio 3T colours the tabs of a connection.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-request-tabbar',
  styles: ':host { display: contents; }',
  templateUrl: './request-tabbar.html',
})
export class RequestTabbar {
  readonly state = inject(WorkspaceState);
  protected readonly environmentColor = computed(
    () => readEnvironmentSettings(this.state.environmentDocument()?.value).color,
  );
  readonly drag = new ListDrag('x', (id, over, side) => {
    const ids = this.state.tabs().map((tab) => tab.id);
    this.state.moveTab(id, dropIndex(ids, over, side));
  });
}
