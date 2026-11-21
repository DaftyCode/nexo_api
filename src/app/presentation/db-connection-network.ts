import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FieldTree } from '@angular/forms/signals';
import type { DbRouteReport } from '../application/database-use-cases';
import { DbForm } from '../domain/db/form';
import { Route } from '../domain/route';
import { RoutePicker } from './route-picker';

/**
 * The «Network» tab of a database connection (DB-25): directly, through a SOCKS5 proxy or
 * through the SSH tunnel of a profile. Nexo opens the way and the driver connects to a local
 * port of it, so TLS still checks the server's own name. «Test the tunnel» reaches the server
 * through it without signing in to the database.
 */
@Component({
  imports: [TranslocoPipe, RoutePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-connection-network',
  template: `
    <app-route-picker [route]="route()" (routeChange)="setRoute($event)" [allowHttp]="false" />
    @if (route().via === 'socks5' && proxyStored()) {
      <p class="muted">{{ 'Leave the proxy password blank to keep the saved one.' | transloco }}</p>
    }
    <p class="muted">
      {{
        'Nexo opens the proxy or the SSH tunnel and the driver connects through it; the server is checked by its own name, which only the far side needs to know.'
          | transloco
      }}
    </p>
    @if (routed()) {
      <div class="button-grid">
        <button type="button" class="button" (click)="testRoute.emit()">
          {{ 'Test the tunnel' | transloco }}
        </button>
      </div>
    }
    @if (tunnel(); as reached) {
      <p class="db-report" role="status">
        {{
          'db.route.reached' | transloco: { v0: reached.host + ':' + reached.port, v1: reached.ms }
        }}
      </p>
    }
  `,
})
export class DbConnectionNetwork {
  readonly fields = input.required<FieldTree<DbForm>>();
  /** Whether the vault holds the saved password of the proxy, kept when left blank. */
  readonly proxyStored = input(false);
  /** What the last «Test the tunnel» said. */
  readonly tunnel = input<DbRouteReport | undefined>(undefined);
  readonly testRoute = output<void>();
  protected readonly route = computed(() => this.fields()().value().route);
  protected readonly routed = computed(() => ['socks5', 'ssh'].includes(this.route().via));

  protected setRoute(route: Route) {
    this.fields()().value.update((form) => ({ ...form, route }));
  }
}
