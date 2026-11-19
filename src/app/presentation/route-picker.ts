import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { Route, emptyRoute, routeProblem } from '../domain/route';
import { WorkspaceState } from './workspace-state';

/**
 * «Connect through»: directly, an HTTP proxy, a SOCKS5 proxy or an SSH profile, with the
 * fields each one needs. Used by requests, collections, protocols and database connections;
 * requests and folders can also inherit the way of the folder or collection above them.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-route-picker',
  templateUrl: './route-picker.html',
  styles: `
    :host {
      display: block;
    }
    .route-fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--nexo-space-6);
      align-items: end;
    }
  `,
})
export class RoutePicker {
  readonly route = model<Route>(emptyRoute());
  /** Whether «Inherit from parent» is offered: requests and folders. */
  readonly inheritable = input(false);
  /** Whether an HTTP proxy is offered: database protocols need SOCKS5 or SSH. */
  readonly allowHttp = input(true);
  protected readonly fields = form(this.route);
  private readonly state = inject(WorkspaceState);
  protected readonly profiles = computed(() =>
    this.state.cases.ssh.profiles(this.state.documents()),
  );
  protected readonly problem = computed(() => routeProblem(this.route()));
}
