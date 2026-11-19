import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { RequestDraft } from '../domain/models';
import { Route, routeOf, withRoute } from '../domain/route';
import { CodeEditor } from './code-editor';
import { RoutePicker } from './route-picker';

/**
 * The settings of a request: timeout, redirects, TLS, protocol, how it reaches its server
 * (directly, a proxy or an SSH tunnel) and client TLS.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, RoutePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-request-settings',
  styles: ':host { display: contents; }',
  templateUrl: './request-settings.html',
})
export class RequestSettings {
  /** The form of the request editor. */
  readonly fields = input.required<FieldTree<RequestDraft>>();
  /** The route kept in the request's transport settings. */
  protected readonly route = computed(() => routeOf(this.fields().transport().value()));
  protected setRoute(route: Route) {
    const transport = this.fields().transport().value;
    transport.set(withRoute(transport(), route));
  }
}
