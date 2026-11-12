import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import type { IntegrationModel } from './integration-panel';

/** An OAuth 2.0 token request to an endpoint, whose token the active request then uses. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-token-exchange',
  styles: ':host { display: contents; }',
  templateUrl: './token-exchange.html',
})
export class TokenExchange {
  /** The form of the integration panel. */
  readonly fields = input.required<FieldTree<IntegrationModel>>();
  /** The settings, to read. */
  protected readonly model = computed(() => this.fields()().value());
  /** Requests the token. */
  readonly exchange = output<void>();
}
